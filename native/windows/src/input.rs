//! Physical input through SendInput: mouse, wheel, drag, text and key chords.
//!
//! Every pointer method can take the target window. The helper then brings it to the
//! front and refuses to deliver input when the point lands on another app's window, so
//! an overlay or a popup from a different process never receives the click.

use std::thread::sleep;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GA_ROOT, GetAncestor, GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, SMTO_ABORTIFHUNG,
    SendMessageTimeoutW, SetCursorPos, WM_NULL, WindowFromPoint,
};

use crate::rpc::{RpcError, parse};
use crate::windows_enum::{bring_to_front, ensure_window, hwnd_value};

fn send(inputs: &[INPUT]) -> Result<(), RpcError> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        // UIPI blocks input into windows of higher integrity (elevated apps).
        return Err(RpcError::new(
            "input_blocked",
            "Windows blocked the synthetic input. The target app may be running as administrator.",
        ));
    }
    Ok(())
}

fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dwFlags: flags, mouseData: data as u32, ..Default::default() } },
    }
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, ..Default::default() } },
    }
}

fn unicode(unit: u16, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, ..Default::default() } },
    }
}

fn is_extended(vk: VIRTUAL_KEY) -> bool {
    matches!(
        vk,
        VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_INSERT | VK_DELETE | VK_HOME | VK_END | VK_PRIOR | VK_NEXT
            | VK_RCONTROL | VK_RMENU | VK_LWIN | VK_RWIN | VK_APPS | VK_DIVIDE | VK_NUMLOCK | VK_SNAPSHOT
    )
}

#[derive(Deserialize, Clone, Copy)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Activate the target window and check that the point belongs to its process.
fn prepare_target(hwnd: Option<i64>, point: Option<Point>, allow_other: bool) -> Result<bool, RpcError> {
    crate::guard::check()?;
    let Some(hwnd) = hwnd else { return Ok(false) };
    let handle = ensure_window(hwnd)?;
    let foreground = bring_to_front(handle);
    if let (Some(point), false) = (point, allow_other) {
        unsafe {
            let hit = WindowFromPoint(POINT { x: point.x, y: point.y });
            let root = GetAncestor(hit, GA_ROOT);
            let mut target_pid = 0u32;
            let mut hit_pid = 0u32;
            GetWindowThreadProcessId(handle, Some(&mut target_pid));
            GetWindowThreadProcessId(root, Some(&mut hit_pid));
            if root != handle && hit_pid != target_pid {
                return Err(RpcError::new(
                    "point_occluded",
                    format!(
                        "The point ({}, {}) is covered by another app's window ({}). Bring the target forward or choose a visible point.",
                        point.x,
                        point.y,
                        hwnd_value(root)
                    ),
                ));
            }
        }
    }
    Ok(foreground)
}

fn button_flags(button: &str) -> Result<(MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS), RpcError> {
    match button {
        "left" => Ok((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
        "right" => Ok((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
        "middle" => Ok((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
        other => Err(RpcError::new("bad_params", format!("Unknown mouse button {other}"))),
    }
}

fn cursor() -> Option<POINT> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok().map(|_| point)
}

fn modifiers_down(names: &[String]) -> Result<Vec<VIRTUAL_KEY>, RpcError> {
    let keys = names.iter().map(|name| modifier(name).ok_or_else(|| unknown_key(name))).collect::<Result<Vec<_>, _>>()?;
    send(&keys.iter().map(|&vk| key(vk, false)).collect::<Vec<_>>())?;
    Ok(keys)
}

fn modifiers_up(keys: &[VIRTUAL_KEY]) {
    let _ = send(&keys.iter().rev().map(|&vk| key(vk, true)).collect::<Vec<_>>());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickParams {
    x: i32,
    y: i32,
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default = "left")]
    button: String,
    #[serde(default = "one")]
    count: u32,
    #[serde(default)]
    modifiers: Vec<String>,
    #[serde(default = "yes")]
    restore_cursor: bool,
    #[serde(default)]
    allow_other_window: bool,
}

fn left() -> String {
    "left".into()
}
fn one() -> u32 {
    1
}
fn yes() -> bool {
    true
}

pub fn click(params: Value) -> Result<Value, RpcError> {
    let params: ClickParams = parse(params)?;
    let point = Point { x: params.x, y: params.y };
    let foreground = prepare_target(params.hwnd, Some(point), params.allow_other_window)?;
    let (down, up) = button_flags(&params.button)?;
    let original = cursor();
    let held = modifiers_down(&params.modifiers)?;
    let result = (|| {
        unsafe { SetCursorPos(point.x, point.y)? };
        sleep(Duration::from_millis(15));
        for index in 0..params.count.clamp(1, 3) {
            if index > 0 {
                sleep(Duration::from_millis(40));
            }
            send(&[mouse(down, 0), mouse(up, 0)])?;
        }
        Ok::<(), RpcError>(())
    })();
    modifiers_up(&held);
    result?;
    if let (true, Some(original)) = (params.restore_cursor, original) {
        sleep(Duration::from_millis(30));
        unsafe {
            let _ = SetCursorPos(original.x, original.y);
        }
    }
    Ok(json!({ "ok": true, "foreground": foreground }))
}

#[derive(Deserialize)]
struct MoveParams {
    x: i32,
    y: i32,
    #[serde(default)]
    hwnd: Option<i64>,
}

pub fn move_mouse(params: Value) -> Result<Value, RpcError> {
    let params: MoveParams = parse(params)?;
    prepare_target(params.hwnd, None, true)?;
    unsafe { SetCursorPos(params.x, params.y)? };
    Ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DragParams {
    from: Point,
    to: Point,
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default = "left")]
    button: String,
    #[serde(default = "steps")]
    steps: u32,
    #[serde(default)]
    allow_other_window: bool,
}

fn steps() -> u32 {
    12
}

pub fn drag(params: Value) -> Result<Value, RpcError> {
    let params: DragParams = parse(params)?;
    let foreground = prepare_target(params.hwnd, Some(params.from), params.allow_other_window)?;
    let (down, up) = button_flags(&params.button)?;
    unsafe { SetCursorPos(params.from.x, params.from.y)? };
    sleep(Duration::from_millis(20));
    send(&[mouse(down, 0)])?;
    let steps = params.steps.clamp(2, 100);
    let result = (|| {
        sleep(Duration::from_millis(40));
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            let x = params.from.x as f64 + (params.to.x - params.from.x) as f64 * t;
            let y = params.from.y as f64 + (params.to.y - params.from.y) as f64 * t;
            unsafe { SetCursorPos(x.round() as i32, y.round() as i32)? };
            send(&[mouse(MOUSEEVENTF_MOVE, 0)])?;
            sleep(Duration::from_millis(12));
        }
        Ok::<(), RpcError>(())
    })();
    // Always release the button, even when a move failed midway.
    let released = send(&[mouse(up, 0)]);
    result?;
    released?;
    Ok(json!({ "ok": true, "foreground": foreground }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScrollParams {
    x: i32,
    y: i32,
    #[serde(default)]
    dx: i32,
    #[serde(default)]
    dy: i32,
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default = "yes")]
    restore_cursor: bool,
    #[serde(default)]
    allow_other_window: bool,
}

/// Scroll with the wheel at a point. dy > 0 scrolls down, dx > 0 scrolls right; one unit
/// is one wheel notch.
pub fn scroll(params: Value) -> Result<Value, RpcError> {
    let params: ScrollParams = parse(params)?;
    let point = Point { x: params.x, y: params.y };
    prepare_target(params.hwnd, Some(point), params.allow_other_window)?;
    let original = cursor();
    unsafe { SetCursorPos(point.x, point.y)? };
    sleep(Duration::from_millis(15));
    let notch = 120; // WHEEL_DELTA
    for _ in 0..params.dy.unsigned_abs().min(100) {
        send(&[mouse(MOUSEEVENTF_WHEEL, if params.dy > 0 { -notch } else { notch })])?;
        sleep(Duration::from_millis(8));
    }
    for _ in 0..params.dx.unsigned_abs().min(100) {
        send(&[mouse(MOUSEEVENTF_HWHEEL, if params.dx > 0 { notch } else { -notch })])?;
        sleep(Duration::from_millis(8));
    }
    if let (true, Some(original)) = (params.restore_cursor, original) {
        unsafe {
            let _ = SetCursorPos(original.x, original.y);
        }
    }
    Ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct TypeParams {
    text: String,
    #[serde(default)]
    hwnd: Option<i64>,
}

/// Part of a text, typed with one keyboard state.
enum Segment {
    /// Plain key presses typed while `modifiers` are held (Shift, AltGr).
    Keys { modifiers: Vec<VIRTUAL_KEY>, presses: Vec<INPUT>, units: usize },
    /// One character the layout cannot type, sent as a Unicode packet.
    Packet { inputs: Vec<INPUT>, units: usize },
    /// Enter or Tab: may move focus or submit, so the text can change in other ways.
    Special { inputs: Vec<INPUT> },
}

/// The key and modifiers that type `unit` on a keyboard layout, like a person would.
/// None when the layout has no plain key for it (emoji, other scripts, dead keys
/// such as ^ or ´, which would combine with the next character).
fn layout_key(unit: u16, layout: HKL, caps_lock: bool) -> Option<(VIRTUAL_KEY, Vec<VIRTUAL_KEY>)> {
    let scan = unsafe { VkKeyScanExW(unit, layout) };
    if scan == -1 {
        return None;
    }
    let vk = VIRTUAL_KEY((scan as u16) & 0xff);
    let state = ((scan as u16) >> 8) & 0xff;
    if state & !0x7 != 0 {
        return None;
    }
    if unsafe { MapVirtualKeyExW(vk.0 as u32, MAPVK_VK_TO_CHAR, Some(layout)) } & 0x8000_0000 != 0 {
        return None;
    }
    let mut shift = state & 1 != 0;
    if caps_lock && char::from_u32(unit as u32).is_some_and(char::is_alphabetic) {
        shift = !shift;
    }
    let mut modifiers = Vec::new();
    if shift {
        modifiers.push(VK_SHIFT);
    }
    match state & 6 {
        // AltGr: the right Alt key. Windows adds the implied Ctrl itself; a separate
        // Ctrl+Alt reads as a shortcut in many apps.
        6 => modifiers.push(VK_RMENU),
        2 => modifiers.push(VK_CONTROL),
        4 => modifiers.push(VK_MENU),
        _ => {}
    }
    Some((vk, modifiers))
}

fn plan(text: &str, layout: HKL, caps_lock: bool) -> Vec<Segment> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut segments: Vec<Segment> = Vec::new();
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        index += 1;
        match unit {
            0x0D => {} // \r: \n already produces Enter
            0x0A => segments.push(Segment::Special { inputs: vec![key(VK_RETURN, false), key(VK_RETURN, true)] }),
            0x09 => segments.push(Segment::Special { inputs: vec![key(VK_TAB, false), key(VK_TAB, true)] }),
            _ => match layout_key(unit, layout, caps_lock) {
                Some((vk, modifiers)) => {
                    if let Some(Segment::Keys { modifiers: held, presses, units }) = segments.last_mut() {
                        if *held == modifiers {
                            presses.extend([key(vk, false), key(vk, true)]);
                            *units += 1;
                            continue;
                        }
                    }
                    segments.push(Segment::Keys { modifiers, presses: vec![key(vk, false), key(vk, true)], units: 1 });
                }
                None => {
                    let mut inputs = vec![unicode(unit, false)];
                    let mut count = 1;
                    if (0xD800..=0xDBFF).contains(&unit) && index < units.len() {
                        inputs.extend([unicode(units[index], false), unicode(units[index], true)]);
                        index += 1;
                        count = 2;
                    }
                    inputs.push(unicode(unit, true));
                    segments.push(Segment::Packet { inputs, units: count });
                }
            },
        }
    }
    segments
}

/// Flow control: wait until the window's thread is back at its message loop. A sent
/// message is handled only when the thread finishes what it is doing, so input is never
/// sent much faster than the app can process it. Apps that fall behind drop or garble
/// keys (see `type_text`).
fn catch_up(window: HWND) {
    unsafe {
        let _ = SendMessageTimeoutW(window, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 500, None);
    }
}

fn key_delay_ms() -> u64 {
    std::env::var("OCU_KEY_DELAY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5)
}

/// Wait until the focused element's text has taken `units` more characters (or has
/// changed and settled, when typing replaced a selection). Returns false on timeout.
/// Without a readable value, waits a conservative time per character instead.
fn wait_applied(value_len: &mut impl FnMut() -> Option<usize>, start: Option<usize>, units: usize) -> bool {
    let Some(start) = start else {
        sleep(Duration::from_millis((units as u64 * 20).min(1500)));
        return true;
    };
    let expected = start + units;
    let begun = Instant::now();
    let timeout = Duration::from_millis(1000 + 40 * units as u64);
    let mut last = start;
    let mut since = Instant::now();
    loop {
        let Some(len) = value_len() else { return false };
        if len == expected {
            return true;
        }
        if len != last {
            last = len;
            since = Instant::now();
        } else if len != start && since.elapsed() >= Duration::from_millis(80) {
            return true;
        }
        if begun.elapsed() > timeout {
            return false;
        }
        sleep(Duration::from_millis(10));
    }
}

/// Type text into the focused element.
///
/// Characters go out as real key presses through the target's keyboard layout, grouped
/// by the modifiers they need. Some apps (WinUI apps such as Windows 11 Notepad) work
/// out a typed character from the keyboard state at the moment they process the key,
/// not when it was sent. A burst then arrives garbled: "Æ" as "æ", "@" as "2", and a
/// run of Unicode packets as copies of the last one. So between groups, while
/// Shift/AltGr is still held, the helper waits until the focused element's text shows
/// the group has landed. `value_len` reads that text's length; it returns None when
/// there is no readable value (password fields among them).
pub fn type_text(params: Value, mut value_len: impl FnMut() -> Option<usize>) -> Result<Value, RpcError> {
    let params: TypeParams = parse(params)?;
    let foreground = prepare_target(params.hwnd, None, true)?;
    let layout = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), None)) };
    let caps_lock = unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 != 0;
    let segments = plan(&params.text, layout, caps_lock);
    let window = unsafe { GetForegroundWindow() };
    // Start only once the app is idle (it may still be busy, e.g. answering a big
    // accessibility read).
    catch_up(window);
    let mut packets = 0;
    let mut unconfirmed = 0;
    for segment in segments {
        let start = value_len();
        match segment {
            Segment::Keys { modifiers, presses, units } => {
                send(&modifiers.iter().map(|&m| key(m, false)).collect::<Vec<_>>())?;
                if !modifiers.is_empty() {
                    sleep(Duration::from_millis(key_delay_ms()));
                }
                let result = (|| {
                    // One key at a time, a few milliseconds apart: some apps drop keys
                    // that arrive faster than a person could type.
                    for press in presses.chunks(2) {
                        send(press)?;
                        sleep(Duration::from_millis(key_delay_ms()));
                        catch_up(window);
                    }
                    Ok::<(), RpcError>(())
                })();
                let landed = result.is_ok() && wait_applied(&mut value_len, start, units);
                // Release the modifiers even if sending failed midway.
                let _ = send(&modifiers.iter().rev().map(|&m| key(m, true)).collect::<Vec<_>>());
                result?;
                if !landed {
                    unconfirmed += units;
                }
            }
            Segment::Packet { inputs, units } => {
                send(&inputs)?;
                catch_up(window);
                packets += 1;
                if !wait_applied(&mut value_len, start, units) {
                    unconfirmed += units;
                }
            }
            Segment::Special { inputs } => {
                send(&inputs)?;
                // Enter/Tab may submit or move focus; give the app a moment to settle.
                sleep(Duration::from_millis(60));
            }
        }
    }
    Ok(json!({
        "ok": true,
        "foreground": foreground,
        "characters": params.text.chars().count(),
        "unicodePackets": packets,
        "unconfirmed": unconfirmed,
    }))
}

fn unknown_key(name: &str) -> RpcError {
    RpcError::new("bad_params", format!("Unknown key name {name:?}"))
}

fn modifier(name: &str) -> Option<VIRTUAL_KEY> {
    match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "control_l" | "ctrl_l" | "cmd" | "command" => Some(VK_CONTROL),
        "control_r" | "ctrl_r" => Some(VK_RCONTROL),
        "shift" | "shift_l" => Some(VK_SHIFT),
        "shift_r" => Some(VK_RSHIFT),
        "alt" | "alt_l" | "option" | "menu" => Some(VK_MENU),
        "alt_r" | "altgr" => Some(VK_RMENU),
        "super" | "super_l" | "win" | "windows" | "meta" => Some(VK_LWIN),
        "super_r" => Some(VK_RWIN),
        _ => None,
    }
}

/// xdotool-style key names (as Codex Computer Use uses), plus common aliases.
fn named_key(name: &str) -> Option<VIRTUAL_KEY> {
    let lower = name.to_ascii_lowercase();
    let vk = match lower.as_str() {
        "return" | "enter" | "kp_enter" => VK_RETURN,
        "escape" | "esc" => VK_ESCAPE,
        "tab" => VK_TAB,
        "backspace" | "back_space" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" | "ins" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "page_up" | "pageup" | "prior" => VK_PRIOR,
        "page_down" | "pagedown" | "next" => VK_NEXT,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "space" | "spacebar" => VK_SPACE,
        "caps_lock" | "capslock" => VK_CAPITAL,
        "num_lock" | "numlock" => VK_NUMLOCK,
        "scroll_lock" | "scrolllock" => VK_SCROLL,
        "pause" | "break" => VK_PAUSE,
        "print" | "printscreen" | "print_screen" => VK_SNAPSHOT,
        "apps" | "contextmenu" | "context_menu" => VK_APPS,
        "kp_add" | "add" => VK_ADD,
        "kp_subtract" | "subtract" => VK_SUBTRACT,
        "kp_multiply" | "multiply" => VK_MULTIPLY,
        "kp_divide" | "divide" => VK_DIVIDE,
        "kp_decimal" | "decimal" => VK_DECIMAL,
        "volumeup" | "audioraisevolume" | "xf86audioraisevolume" => VK_VOLUME_UP,
        "volumedown" | "audiolowervolume" | "xf86audiolowervolume" => VK_VOLUME_DOWN,
        "volumemute" | "audiomute" | "xf86audiomute" => VK_VOLUME_MUTE,
        "mediaplaypause" | "audioplay" | "xf86audioplay" => VK_MEDIA_PLAY_PAUSE,
        "medianexttrack" | "audionext" | "xf86audionext" => VK_MEDIA_NEXT_TRACK,
        "mediaprevtrack" | "audioprev" | "xf86audioprev" => VK_MEDIA_PREV_TRACK,
        "plus" => VK_OEM_PLUS,
        "minus" => VK_OEM_MINUS,
        "comma" => VK_OEM_COMMA,
        "period" => VK_OEM_PERIOD,
        _ => {
            if let Some(number) = lower.strip_prefix("kp_").and_then(|d| d.parse::<u16>().ok()).filter(|d| *d <= 9) {
                return Some(VIRTUAL_KEY(VK_NUMPAD0.0 + number));
            }
            if let Some(number) = lower.strip_prefix('f').and_then(|d| d.parse::<u16>().ok()).filter(|d| (1..=24).contains(d)) {
                return Some(VIRTUAL_KEY(VK_F1.0 + number - 1));
            }
            return modifier(name);
        }
    };
    Some(vk)
}

/// A single printable character: letters and digits map to their virtual keys; other
/// characters go through the active keyboard layout.
fn char_key(name: &str) -> Option<(VIRTUAL_KEY, Vec<VIRTUAL_KEY>)> {
    let mut chars = name.chars();
    let ch = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    if ch.is_ascii_alphanumeric() {
        return Some((VIRTUAL_KEY(ch.to_ascii_uppercase() as u16), Vec::new()));
    }
    let mut units = [0u16; 2];
    if ch.encode_utf16(&mut units).len() != 1 {
        return None;
    }
    let scan = unsafe { VkKeyScanW(units[0]) };
    if scan == -1 {
        return None;
    }
    let vk = VIRTUAL_KEY((scan as u16) & 0xff);
    let shift_state = ((scan as u16) >> 8) & 0xff;
    let mut extra = Vec::new();
    if shift_state & 1 != 0 {
        extra.push(VK_SHIFT);
    }
    if shift_state & 2 != 0 {
        extra.push(VK_CONTROL);
    }
    if shift_state & 4 != 0 {
        extra.push(VK_MENU);
    }
    Some((vk, extra))
}

#[derive(Deserialize)]
struct KeyParams {
    key: String,
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default = "one")]
    repeat: u32,
}

/// Parse "ctrl+shift+s", "Return", "super+c", "KP_0" into held modifiers plus one key.
fn parse_chord(chord: &str) -> Result<Vec<VIRTUAL_KEY>, RpcError> {
    let parts: Vec<&str> = if chord == "+" { vec!["+"] } else { chord.split('+').map(str::trim).collect() };
    if parts.iter().any(|part| part.is_empty()) {
        return Err(unknown_key(chord));
    }
    let (last, mods) = parts.split_last().ok_or_else(|| unknown_key(chord))?;
    let mut keys = Vec::new();
    for name in mods {
        keys.push(modifier(name).ok_or_else(|| unknown_key(name))?);
    }
    if let Some(vk) = named_key(last) {
        keys.push(vk);
    } else if let Some((vk, extra)) = char_key(last) {
        for vk in extra {
            if !keys.contains(&vk) {
                keys.push(vk);
            }
        }
        keys.push(vk);
    } else {
        return Err(unknown_key(last));
    }
    Ok(keys)
}

pub fn press_key(params: Value) -> Result<Value, RpcError> {
    let params: KeyParams = parse(params)?;
    let keys = parse_chord(&params.key)?;
    let foreground = prepare_target(params.hwnd, None, true)?;
    for index in 0..params.repeat.clamp(1, 50) {
        if index > 0 {
            sleep(Duration::from_millis(20));
        }
        // Hold the whole chord briefly: some apps read which keys are down when they
        // process a key, not when it was sent (see `type_text`).
        send(&keys.iter().map(|&vk| key(vk, false)).collect::<Vec<_>>())?;
        sleep(Duration::from_millis(40));
        send(&keys.iter().rev().map(|&vk| key(vk, true)).collect::<Vec<_>>())?;
    }
    Ok(json!({ "ok": true, "foreground": foreground }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chords() {
        assert_eq!(parse_chord("ctrl+s").unwrap(), vec![VK_CONTROL, VIRTUAL_KEY('S' as u16)]);
        assert_eq!(parse_chord("Return").unwrap(), vec![VK_RETURN]);
        assert_eq!(parse_chord("shift+Page_Down").unwrap(), vec![VK_SHIFT, VK_NEXT]);
        assert_eq!(parse_chord("F12").unwrap(), vec![VK_F12]);
        assert_eq!(parse_chord("KP_7").unwrap(), vec![VK_NUMPAD7]);
        assert!(parse_chord("ctrl+").is_err());
        assert!(parse_chord("hyper+x").is_err());
    }
}
