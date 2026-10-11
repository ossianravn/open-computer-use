//! The user stays in charge: low-level keyboard and mouse hooks notice physical input.
//!
//! - A physical Esc press stops every state-changing call for a while, so the agent
//!   halts and asks the user how to continue.
//! - Recent physical keyboard or mouse-button activity makes input calls back off, so
//!   the agent never fights the user for the pointer.
//!
//! Synthetic input (ours included) carries the "injected" flag and is ignored. Only
//! timestamps are kept; no key or position is recorded.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{Value, json};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG,
    MSLLHOOKSTRUCT, SetWindowsHookExW, TranslateMessage, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_MOUSEMOVE,
    WM_SYSKEYDOWN,
};

use crate::rpc::RpcError;

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
static LAST_INPUT: AtomicU64 = AtomicU64::new(0);
static LAST_ESC: AtomicU64 = AtomicU64::new(0);
static CLEARED_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    // Offset by one so 0 always means "never".
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn user_active_ms() -> u64 {
    env_ms("OCU_USER_ACTIVE_MS", 700)
}

fn stop_latch_ms() -> u64 {
    env_ms("OCU_STOP_LATCH_MS", 20_000)
}

unsafe extern "system" fn keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let now = now_ms();
            LAST_INPUT.store(now, Ordering::Relaxed);
            let down = wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN;
            if down && info.vkCode == VK_ESCAPE.0 as u32 {
                LAST_ESC.store(now, Ordering::Relaxed);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && wparam.0 as u32 != WM_MOUSEMOVE {
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if info.flags & LLMHF_INJECTED == 0 {
            LAST_INPUT.store(now_ms(), Ordering::Relaxed);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Install the hooks on their own message-loop thread. OCU_GUARD=0 turns them off.
pub fn start() {
    now_ms();
    if std::env::var("OCU_GUARD").is_ok_and(|v| v == "0") {
        return;
    }
    std::thread::spawn(|| unsafe {
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0);
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), None, 0);
        ENABLED.store(keyboard_hook.is_ok(), Ordering::Relaxed);
        if let Err(error) = keyboard_hook.as_ref().and(mouse_hook.as_ref()) {
            eprintln!("ocu-win: input guard unavailable: {error}");
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    });
}

fn ago(at: u64) -> Option<u64> {
    (at != 0).then(|| now_ms().saturating_sub(at))
}

/// Fail when the user pressed Esc recently. Applies to every state-changing call.
pub fn check_stop() -> Result<(), RpcError> {
    let esc = LAST_ESC.load(Ordering::Relaxed);
    if esc > CLEARED_AT.load(Ordering::Relaxed) && ago(esc).is_some_and(|ms| ms < stop_latch_ms()) {
        return Err(RpcError::new(
            "stopped_by_user",
            "The user pressed Esc to stop computer use. Stop acting and ask the user how to continue.",
        ));
    }
    Ok(())
}

/// Also fail while the user is using the keyboard or mouse. Applies to physical input,
/// which takes the foreground and the pointer; accessibility actions run in the
/// background and do not need it.
pub fn check() -> Result<(), RpcError> {
    check_stop()?;
    if ago(LAST_INPUT.load(Ordering::Relaxed)).is_some_and(|ms| ms < user_active_ms()) {
        return Err(RpcError::new(
            "user_active",
            "The user is using the keyboard or mouse right now. Wait a moment, check the app state, then retry.",
        ));
    }
    Ok(())
}

pub fn status(_: Value) -> Result<Value, RpcError> {
    let esc = LAST_ESC.load(Ordering::Relaxed);
    Ok(json!({
        "enabled": ENABLED.load(Ordering::Relaxed),
        "lastPhysicalInputMsAgo": ago(LAST_INPUT.load(Ordering::Relaxed)),
        "lastEscMsAgo": ago(esc),
        "stopped": esc > CLEARED_AT.load(Ordering::Relaxed) && ago(esc).is_some_and(|ms| ms < stop_latch_ms()),
    }))
}

/// Lift an Esc stop early, after the user has said to continue.
pub fn clear_stop(_: Value) -> Result<Value, RpcError> {
    CLEARED_AT.store(now_ms(), Ordering::Relaxed);
    Ok(json!({ "ok": true }))
}
