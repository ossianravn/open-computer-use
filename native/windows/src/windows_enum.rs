//! Top-level window inventory and activation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, IsWindowEnabled, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GW_OWNER, GWL_EXSTYLE, GetClassNameW,
    GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    SW_RESTORE, SetForegroundWindow, ShowWindow, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

use crate::rpc::{RpcError, parse, to_value};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl From<RECT> for Rect {
    fn from(rect: RECT) -> Self {
        Rect { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub hwnd: i64,
    pub title: String,
    pub class_name: String,
    pub pid: u32,
    pub process_name: String,
    pub exe_path: Option<String>,
    pub rect: Rect,
    pub minimized: bool,
    pub maximized: bool,
    pub foreground: bool,
    /// False while a modal dialog blocks the window.
    pub enabled: bool,
    /// The window that owns this one (dialogs, popups), if any.
    pub owner: Option<i64>,
    /// A window a person would see in the taskbar or Alt+Tab.
    pub app_window: bool,
    pub dpi: u32,
}

pub fn hwnd_from(value: i64) -> HWND {
    HWND(value as isize as *mut core::ffi::c_void)
}

pub fn hwnd_value(hwnd: HWND) -> i64 {
    hwnd.0 as isize as i64
}

pub fn ensure_window(hwnd: i64) -> Result<HWND, RpcError> {
    let handle = hwnd_from(hwnd);
    if unsafe { IsWindow(Some(handle)) }.as_bool() {
        Ok(handle)
    } else {
        Err(RpcError::new("window_gone", format!("Window {hwnd} no longer exists. List windows again.")))
    }
}

fn window_text(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied.max(0) as usize])
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let copied = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..copied.max(0) as usize])
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

pub fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
    }
}

/// The visible frame, without the invisible resize borders Windows 10+ adds.
pub fn frame_rect(hwnd: HWND) -> Rect {
    let mut rect = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_err()
        {
            let _ = GetWindowRect(hwnd, &mut rect);
        }
    }
    rect.into()
}

/// UWP apps live inside ApplicationFrameHost; the hosted CoreWindow child carries the
/// real app's process id.
fn hosted_app_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
    struct Search {
        frame_pid: u32,
        found: Option<u32>,
    }
    unsafe extern "system" fn visit(child: HWND, lparam: LPARAM) -> BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        let pid = window_pid(child);
        if pid != 0 && pid != search.frame_pid {
            search.found = Some(pid);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search { frame_pid, found: None };
    unsafe {
        let _ = EnumChildWindows(Some(frame), Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

pub fn describe_window(hwnd: HWND) -> WindowInfo {
    let mut pid = window_pid(hwnd);
    let mut exe_path = process_path(pid);
    if exe_path.as_deref().map(file_name).is_some_and(|name| name.eq_ignore_ascii_case("ApplicationFrameHost.exe")) {
        if let Some(hosted) = hosted_app_pid(hwnd, pid) {
            pid = hosted;
            exe_path = process_path(hosted).or(exe_path);
        }
    }
    let process_name = exe_path.as_deref().map(file_name).unwrap_or_default();
    unsafe {
        WindowInfo {
            hwnd: hwnd_value(hwnd),
            title: window_text(hwnd),
            class_name: class_name(hwnd),
            pid,
            process_name,
            exe_path,
            rect: frame_rect(hwnd),
            minimized: IsIconic(hwnd).as_bool(),
            maximized: IsZoomed(hwnd).as_bool(),
            foreground: GetForegroundWindow() == hwnd,
            enabled: IsWindowEnabled(hwnd).as_bool(),
            owner: GetWindow(hwnd, GW_OWNER).ok().filter(|owner| !owner.is_invalid()).map(hwnd_value),
            app_window: is_app_window(hwnd),
            dpi: GetDpiForWindow(hwnd),
        }
    }
}

/// An app window a person would see in the taskbar or Alt+Tab.
fn is_app_window(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || is_cloaked(hwnd) {
            return false;
        }
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let has_owner = GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid());
        if ex_style & WS_EX_APPWINDOW.0 == 0 && (ex_style & WS_EX_TOOLWINDOW.0 != 0 || has_owner) {
            return false;
        }
        if GetWindowTextLengthW(hwnd) == 0 {
            return false;
        }
        let rect = frame_rect(hwnd);
        IsIconic(hwnd).as_bool() || (rect.width > 1 && rect.height > 1)
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListParams {
    /// Include every visible top-level window, not just app windows (dialogs, popups).
    include_all: bool,
}

pub fn list_windows(params: Value) -> Result<Value, RpcError> {
    let params: ListParams = parse(params)?;
    let mut handles: Vec<HWND> = Vec::new();
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        handles.push(hwnd);
        BOOL(1)
    }
    unsafe {
        EnumWindows(Some(collect), LPARAM(&mut handles as *mut Vec<HWND> as isize))?;
    }
    let windows: Vec<WindowInfo> = handles
        .into_iter()
        .filter(|&hwnd| {
            if params.include_all {
                unsafe { IsWindowVisible(hwnd).as_bool() && !is_cloaked(hwnd) }
            } else {
                is_app_window(hwnd)
            }
        })
        .map(describe_window)
        .collect();
    to_value(windows)
}

#[derive(Deserialize)]
struct ActivateParams {
    hwnd: i64,
}

fn tap_alt() {
    let key = |flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_MENU, dwFlags: flags, ..Default::default() } },
    };
    unsafe {
        SendInput(&[key(Default::default()), key(KEYEVENTF_KEYUP)], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Bring a window to the foreground so physical input reaches it.
pub fn bring_to_front(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if GetForegroundWindow() == hwnd {
            return true;
        }
        // Windows only lets the foreground thread change focus. Joining its input queue
        // for the call is the documented way to borrow that right.
        let foreground = GetForegroundWindow();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);
        let own_thread = GetCurrentThreadId();
        let attached = foreground_thread != 0
            && foreground_thread != own_thread
            && AttachThreadInput(own_thread, foreground_thread, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(own_thread, foreground_thread, false);
        }
        if GetForegroundWindow() == hwnd {
            return true;
        }
        // Last resort: a synthetic Alt press counts as recent user input, which unlocks
        // SetForegroundWindow for this process.
        tap_alt();
        let _ = SetForegroundWindow(hwnd);
        std::thread::sleep(std::time::Duration::from_millis(30));
        GetForegroundWindow() == hwnd
    }
}

pub fn activate_window(params: Value) -> Result<Value, RpcError> {
    let params: ActivateParams = parse(params)?;
    let hwnd = ensure_window(params.hwnd)?;
    let foreground = bring_to_front(hwnd);
    Ok(serde_json::json!({ "foreground": foreground, "window": describe_window(hwnd) }))
}
