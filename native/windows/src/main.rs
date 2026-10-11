//! ocu-win: the Windows platform helper for open-computer-use.
//!
//! Speaks newline-delimited JSON-RPC on stdio. One request per line:
//!   {"id": 1, "method": "listWindows", "params": {}}
//! One response per line:
//!   {"id": 1, "result": ...}  or  {"id": 1, "error": {"code": "...", "message": "..."}}
//!
//! All UI Automation work happens on the main thread, in request order. Diagnostics go
//! to stderr so they never corrupt the protocol stream.

mod capture;
mod guard;
mod input;
mod rpc;
mod uia;
mod windows_enum;

use std::io::{BufRead, Write};

use rpc::{Request, Response, RpcError};
use serde_json::Value;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    unsafe {
        // Physical pixels everywhere: UIA rectangles, window rectangles, SendInput and
        // screenshots then share one coordinate space.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            eprintln!("ocu-win: CoInitializeEx failed: {hr:?}");
        }
    }

    guard::start();
    let mut session = match uia::Session::new() {
        Ok(session) => session,
        Err(error) => {
            eprintln!("ocu-win: cannot create UI Automation client: {error}");
            std::process::exit(2);
        }
    };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => {
                let id = request.id.clone();
                match dispatch(&mut session, &request.method, request.params) {
                    Ok(result) => Response::ok(id, result),
                    Err(error) => Response::err(id, error),
                }
            }
            Err(error) => Response::err(Value::Null, RpcError::new("bad_request", error.to_string())),
        };
        let encoded = serde_json::to_string(&response).unwrap_or_else(|error| {
            format!(r#"{{"id":null,"error":{{"code":"encode_failed","message":{:?}}}}}"#, error.to_string())
        });
        if writeln!(stdout, "{encoded}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}

fn dispatch(session: &mut uia::Session, method: &str, params: Value) -> Result<Value, RpcError> {
    match method {
        "ping" => Ok(serde_json::json!({ "version": VERSION, "platform": "windows" })),
        "listWindows" => windows_enum::list_windows(params),
        "snapshot" => session.snapshot(params),
        "elementAction" => session.element_action(params),
        "elementInfo" => session.element_info(params),
        "elementAtPoint" => session.element_at_point(params),
        "focusedElement" => session.focused_element(params),
        "activateWindow" => windows_enum::activate_window(params),
        "click" => input::click(params),
        "moveMouse" => input::move_mouse(params),
        "drag" => input::drag(params),
        "scroll" => input::scroll(params),
        "typeText" => input::type_text(params),
        "pressKey" => input::press_key(params),
        "screenshot" => capture::screenshot(params),
        "guardStatus" => guard::status(params),
        "clearStop" => guard::clear_stop(params),
        _ => Err(RpcError::new("unknown_method", format!("Unknown method {method}"))),
    }
}
