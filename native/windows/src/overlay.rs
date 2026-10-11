//! A visible sign that an agent is using the computer: a blue glow around the edges of
//! the screen it is working on, and a label at the top ("open-cu is using Notepad ·
//! Esc to stop"), like Codex Computer Use shows.
//!
//! - It fades in when the server reports activity on a window, breathes gently while
//!   the agent keeps working, and fades out after a stretch without activity. A
//!   physical Esc press (see guard.rs) hides it at once.
//! - The windows are layered, click-through, never activated and topmost. They are
//!   excluded from screen capture, so the agent's own screenshots never contain them.
//! - Four thin strips plus the label keep the bitmaps small, so the breathing animation
//!   costs almost nothing even on large monitors.
//!
//! OCU_OVERLAY=0 turns it off; OCU_OVERLAY_CAPTURE=1 lets screen capture see it (for
//! documentation screenshots).

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CLIP_DEFAULT_PRECIS, CreateCompatibleDC, CreateDIBSection, CreateFontW, CreateSolidBrush, DEFAULT_CHARSET,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, Ellipse, FW_SEMIBOLD, GetDC, GetMonitorInfoW, GetTextExtentPoint32W, HBITMAP,
    HDC, HGDIOBJ, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow, OUT_DEFAULT_PRECIS, ReleaseDC,
    SelectObject, SetBkMode, SetTextColor, TRANSPARENT, TextOutW,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HTTRANSPARENT, HWND_TOPMOST, KillTimer, MSG,
    PM_NOREMOVE, PeekMessageW, PostThreadMessageW, RegisterClassExW, SPI_GETCLIENTAREAANIMATION, SW_HIDE,
    SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetTimer,
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, SystemParametersInfoW, TranslateMessage, ULW_ALPHA,
    UpdateLayeredWindow, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_NCHITTEST, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::{BOOL, PCWSTR, w};

use crate::rpc::{RpcError, parse};

const WM_OVERLAY: u32 = WM_APP + 1;
const FRAME_MS: u32 = 50;
/// The glow colour (#3D7BFF), as B, G, R.
const BLUE: [f32; 3] = [255.0, 123.0, 61.0];

static THREAD: AtomicU32 = AtomicU32::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Option<Request>> = Mutex::new(None);

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default = "yes")]
    show: bool,
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default)]
    label: String,
    #[serde(default = "default_idle")]
    idle_ms: u64,
}

fn yes() -> bool {
    true
}
fn default_idle() -> u64 {
    15_000
}

pub fn start() {
    if std::env::var("OCU_OVERLAY").is_ok_and(|v| v == "0" || v.eq_ignore_ascii_case("off")) {
        return;
    }
    std::thread::spawn(run);
}

fn send(request: Request) -> Result<Value, RpcError> {
    let thread = THREAD.load(Ordering::Acquire);
    if thread == 0 || !ENABLED.load(Ordering::Acquire) {
        return Ok(json!({ "ok": true, "enabled": false }));
    }
    *PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(request);
    unsafe {
        let _ = PostThreadMessageW(thread, WM_OVERLAY, WPARAM(0), LPARAM(0));
    }
    Ok(json!({ "ok": true, "enabled": true }))
}

/// Show (or keep showing) the overlay on the monitor of `hwnd`.
pub fn show(params: Value) -> Result<Value, RpcError> {
    let mut request: Request = parse(params)?;
    request.show = true;
    send(request)
}

pub fn hide(_: Value) -> Result<Value, RpcError> {
    send(Request { show: false, hwnd: None, label: String::new(), idle_ms: 0 })
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if message == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// A premultiplied 32-bit bitmap selected into a memory DC, plus where it goes on screen.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    old: HGDIOBJ,
    pixels: *mut u8,
    origin: POINT,
    size: SIZE,
}

impl Surface {
    fn new(origin: POINT, width: i32, height: i32) -> Option<Self> {
        let width = width.max(1);
        let height = height.max(1);
        unsafe {
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            let old = SelectObject(dc, HGDIOBJ(bitmap.0));
            Some(Self { dc, bitmap, old, pixels: bits as *mut u8, origin, size: SIZE { cx: width, cy: height } })
        }
    }

    fn pixels(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.pixels, (self.size.cx * self.size.cy * 4) as usize) }
    }

    fn present(&self, window: HWND, opacity: f32) {
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: (opacity.clamp(0.0, 1.0) * 255.0).round() as u8,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let source = POINT { x: 0, y: 0 };
        unsafe {
            let _ = UpdateLayeredWindow(
                window,
                None,
                Some(&self.origin),
                Some(&self.size),
                Some(self.dc),
                Some(&source),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
        }
    }
}

/// Change only a layered window's overall opacity; its pixels stay as last presented.
fn set_opacity(window: HWND, opacity: f32) {
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: (opacity.clamp(0.0, 1.0) * 255.0).round() as u8,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    unsafe {
        let _ = UpdateLayeredWindow(window, None, None, None, None, None, COLORREF(0), Some(&blend), ULW_ALPHA);
    }
}

fn raise(windows: &[HWND]) {
    for window in windows {
        unsafe {
            let _ = SetWindowPos(*window, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}

/// Glow strength at `distance` pixels in from the screen edge.
fn glow(distance: f32, thickness: f32, line: f32) -> f32 {
    if distance < 0.0 || distance >= thickness {
        return 0.0;
    }
    let line_alpha: f32 = if distance < line { 0.9 } else { 0.0 };
    let fade = 1.0 - distance / thickness;
    line_alpha.max(0.68 * fade * fade)
}

fn paint_edge(surface: &mut Surface, alpha_at: impl Fn(i32, i32) -> f32) {
    let width = surface.size.cx;
    let height = surface.size.cy;
    let pixels = surface.pixels();
    for y in 0..height {
        for x in 0..width {
            let a = alpha_at(x, y).clamp(0.0, 1.0);
            let i = ((y * width + x) * 4) as usize;
            pixels[i] = (BLUE[0] * a) as u8;
            pixels[i + 1] = (BLUE[1] * a) as u8;
            pixels[i + 2] = (BLUE[2] * a) as u8;
            pixels[i + 3] = (255.0 * a) as u8;
        }
    }
}

/// The label pill: a dark rounded bar with a blue dot and white text.
fn paint_pill(text: &str, scale: f32, monitor: RECT, top: i32) -> Option<Surface> {
    let height = (30.0 * scale).round() as i32;
    let pad = (14.0 * scale).round() as i32;
    let dot = (8.0 * scale).round() as i32;
    let gap = (9.0 * scale).round() as i32;
    let wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        let font = CreateFontW(
            -(13.5 * scale).round() as i32,
            0,
            0,
            0,
            FW_SEMIBOLD.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY,
            0,
            w!("Segoe UI"),
        );
        // Measure with the font on a scratch DC.
        let screen = GetDC(None);
        let measure = CreateCompatibleDC(Some(screen));
        ReleaseDC(None, screen);
        let previous = SelectObject(measure, HGDIOBJ(font.0));
        let mut extent = SIZE::default();
        let _ = GetTextExtentPoint32W(measure, &wide, &mut extent);
        SelectObject(measure, previous);
        let _ = DeleteDC(measure);

        let width = pad + dot + gap + extent.cx + pad;
        let origin = POINT { x: monitor.left + (monitor.right - monitor.left - width) / 2, y: top };
        let mut surface = Surface::new(origin, width, height)?;

        // Opaque background first: GDI draws colour but leaves alpha alone, so the mask
        // and premultiplication are applied afterwards.
        let background = [17u8, 24, 39]; // #111827 as R, G, B
        for pixel in surface.pixels().chunks_exact_mut(4) {
            pixel.copy_from_slice(&[background[2], background[1], background[0], 0]);
        }
        let brush = CreateSolidBrush(COLORREF(0x00FF7B3D)); // the glow blue, as 0x00BBGGRR
        let previous_brush = SelectObject(surface.dc, HGDIOBJ(brush.0));
        let pen = windows::Win32::Graphics::Gdi::GetStockObject(windows::Win32::Graphics::Gdi::NULL_PEN);
        let previous_pen = SelectObject(surface.dc, pen);
        let dot_top = (height - dot) / 2;
        let _ = Ellipse(surface.dc, pad, dot_top, pad + dot + 1, dot_top + dot + 1);
        SelectObject(surface.dc, previous_pen);
        SelectObject(surface.dc, previous_brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));

        let previous_font = SelectObject(surface.dc, HGDIOBJ(font.0));
        SetBkMode(surface.dc, TRANSPARENT);
        SetTextColor(surface.dc, COLORREF(0x00FFFFFF));
        let _ = TextOutW(surface.dc, pad + dot + gap, (height - extent.cy) / 2, &wide);
        SelectObject(surface.dc, previous_font);
        let _ = DeleteObject(HGDIOBJ(font.0));

        // Rounded-pill coverage with a one-pixel soft edge, then premultiply.
        let radius = height as f32 / 2.0;
        let opacity = 0.92;
        let size = surface.size;
        let pixels = surface.pixels();
        for y in 0..size.cy {
            for x in 0..size.cx {
                let cx = (x as f32 + 0.5).clamp(radius, size.cx as f32 - radius);
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - radius;
                let distance = (dx * dx + dy * dy).sqrt();
                let coverage = (radius - distance + 0.5).clamp(0.0, 1.0) * opacity;
                let i = ((y * size.cx + x) * 4) as usize;
                for c in 0..3 {
                    pixels[i + c] = (pixels[i + c] as f32 * coverage) as u8;
                }
                pixels[i + 3] = (255.0 * coverage) as u8;
            }
        }
        Some(surface)
    }
}

/// The overlay for one monitor: four edge strips and the label.
struct Scene {
    monitor: RECT,
    label: String,
    surfaces: Vec<Surface>,
}

fn monitor_of(hwnd: Option<i64>) -> Option<(RECT, f32)> {
    let window = HWND(hwnd? as isize as *mut core::ffi::c_void);
    unsafe {
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let (mut dpi, mut unused) = (96u32, 96u32);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut unused);
        Some((info.rcMonitor, dpi.max(96) as f32 / 96.0))
    }
}

fn build_scene(monitor: RECT, scale: f32, label: &str) -> Option<Scene> {
    let width = monitor.right - monitor.left;
    let height = monitor.bottom - monitor.top;
    let thickness = (18.0 * scale).round().max(8.0);
    let line = (2.0 * scale).round().max(1.0);
    let band = thickness as i32;
    let mut surfaces = Vec::new();

    let mut top = Surface::new(POINT { x: monitor.left, y: monitor.top }, width, band)?;
    paint_edge(&mut top, |x, y| {
        let (x, y) = (x as f32, y as f32);
        glow(y, thickness, line).max(glow(x, thickness, line)).max(glow(width as f32 - 1.0 - x, thickness, line))
    });
    surfaces.push(top);

    let mut bottom = Surface::new(POINT { x: monitor.left, y: monitor.bottom - band }, width, band)?;
    paint_edge(&mut bottom, |x, y| {
        let (x, y) = (x as f32, (band - 1 - y) as f32);
        glow(y, thickness, line).max(glow(x, thickness, line)).max(glow(width as f32 - 1.0 - x, thickness, line))
    });
    surfaces.push(bottom);

    let side = height - 2 * band;
    let mut left = Surface::new(POINT { x: monitor.left, y: monitor.top + band }, band, side)?;
    paint_edge(&mut left, |x, _| glow(x as f32, thickness, line));
    surfaces.push(left);

    let mut right = Surface::new(POINT { x: monitor.right - band, y: monitor.top + band }, band, side)?;
    paint_edge(&mut right, |x, _| glow((band - 1 - x) as f32, thickness, line));
    surfaces.push(right);

    let text = if label.is_empty() {
        "open-cu is using your computer  ·  Esc to stop".to_string()
    } else {
        format!("open-cu is using {label}  ·  Esc to stop")
    };
    surfaces.push(paint_pill(&text, scale, monitor, monitor.top + (10.0 * scale).round() as i32)?);
    Some(Scene { monitor, label: label.to_string(), surfaces })
}

fn animations_enabled() -> bool {
    let mut enabled = BOOL(1);
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut enabled as *mut BOOL as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    enabled.as_bool()
}

fn run() {
    unsafe {
        // Make sure this thread has a message queue before anyone posts to it.
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);

        let instance = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("OpenCuOverlay"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        let capture_visible = std::env::var("OCU_OVERLAY_CAPTURE").is_ok_and(|v| v == "1");
        let mut windows: Vec<HWND> = Vec::new();
        for _ in 0..5 {
            let Ok(window) = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                w!("OpenCuOverlay"),
                w!("open-cu overlay"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                Some(instance.into()),
                None,
            ) else {
                eprintln!("ocu-win: overlay unavailable (window creation failed)");
                return;
            };
            if !capture_visible {
                let _ = SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE);
            }
            windows.push(window);
        }
        THREAD.store(windows::Win32::System::Threading::GetCurrentThreadId(), Ordering::Release);
        ENABLED.store(true, Ordering::Release);

        let mut scene: Option<Scene> = None;
        let mut shown = false;
        let mut timer = 0usize;
        let mut opacity = 0.0f32;
        let mut presented = u8::MAX;
        let mut target = 0.0f32;
        let mut last_touch = Instant::now();
        let mut idle = Duration::from_millis(default_idle());
        let started = Instant::now();
        let breathe = animations_enabled();

        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.hwnd.is_invalid() && message.message == WM_OVERLAY {
                let request = PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
                if let Some(request) = request {
                    if request.show {
                        if let Some((monitor, scale)) = monitor_of(request.hwnd) {
                            let stale = scene.as_ref().is_none_or(|current| {
                                current.monitor != monitor || current.label != request.label
                            });
                            if stale {
                                scene = build_scene(monitor, scale, &request.label);
                                if let Some(current) = &scene {
                                    for (surface, window) in current.surfaces.iter().zip(&windows) {
                                        surface.present(*window, opacity);
                                    }
                                }
                            }
                        }
                        last_touch = Instant::now();
                        idle = Duration::from_millis(request.idle_ms.clamp(1_000, 600_000));
                        target = 1.0;
                        // Stay above windows the agent brings forward.
                        if shown {
                            raise(&windows);
                        }
                    } else {
                        target = 0.0;
                    }
                    if timer == 0 && scene.is_some() {
                        timer = SetTimer(None, 0, FRAME_MS, None);
                    }
                }
                continue;
            }
            if message.hwnd.is_invalid() && message.message == WM_TIMER {
                if crate::guard::stop_requested() {
                    // The user pressed Esc: get out of the way immediately.
                    target = 0.0;
                    opacity = 0.0;
                } else if last_touch.elapsed() > idle {
                    target = 0.0;
                }
                let step = if target > opacity { FRAME_MS as f32 / 180.0 } else { FRAME_MS as f32 / 450.0 };
                opacity = if target > opacity { (opacity + step).min(target) } else { (opacity - step).max(target) };
                let mut shown_opacity = opacity;
                if breathe && target == 1.0 && opacity == 1.0 {
                    let phase = started.elapsed().as_secs_f32() / 2.6 * std::f32::consts::TAU;
                    shown_opacity = 0.8 + 0.2 * (0.5 + 0.5 * phase.cos());
                }
                let level = (shown_opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
                if scene.is_some() && level != presented {
                    for window in &windows {
                        set_opacity(*window, shown_opacity);
                    }
                    presented = level;
                    if !shown {
                        for window in &windows {
                            let _ = ShowWindow(*window, SW_SHOWNOACTIVATE);
                        }
                        raise(&windows);
                        shown = true;
                    }
                }
                if opacity == 0.0 && target == 0.0 {
                    for window in &windows {
                        let _ = ShowWindow(*window, SW_HIDE);
                    }
                    shown = false;
                    presented = u8::MAX;
                    let _ = KillTimer(None, timer);
                    timer = 0;
                }
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
