//! Window and screen capture.
//!
//! Windows are captured with PrintWindow(PW_RENDERFULLCONTENT), which renders the
//! window itself, so overlapping windows never leak into the image. If that yields a
//! blank frame (some GPU-composited apps), the visible screen area is copied instead.

use std::io::Cursor;

use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ImageFormat, RgbImage};
use serde::Deserialize;
use serde_json::{Value, json};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    MONITOR_DEFAULTTONEAREST, MonitorFromWindow, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HBITMAP, HDC, HGDIOBJ, ReleaseDC, SRCCOPY,
    SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, GetWindowRect, IsIconic, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

use crate::rpc::{RpcError, parse};
use crate::windows_enum::{Rect, ensure_window, frame_rect};

const PW_RENDERFULLCONTENT: u32 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotParams {
    #[serde(default)]
    hwnd: Option<i64>,
    /// Longest edge of the returned image, in pixels. The image is never upscaled.
    #[serde(default = "default_max_edge")]
    max_edge: u32,
    #[serde(default = "default_format")]
    format: String,
    #[serde(default = "default_quality")]
    quality: u8,
}

fn default_max_edge() -> u32 {
    1366
}
fn default_format() -> String {
    "jpeg".into()
}
fn default_quality() -> u8 {
    80
}

struct Bgra {
    width: i32,
    height: i32,
    pixels: Vec<u8>,
}

/// Copy a bitmap selected into a memory DC out as top-down BGRA.
unsafe fn read_bitmap(dc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Result<Bgra, RpcError> {
    let mut info = BITMAPINFO {
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
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let lines = unsafe {
        GetDIBits(dc, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS)
    };
    if lines == 0 {
        return Err(RpcError::new("capture_failed", "Could not read the captured bitmap."));
    }
    Ok(Bgra { width, height, pixels })
}

/// Run `draw` against a fresh memory bitmap of the given size and return its pixels.
fn with_bitmap(width: i32, height: i32, draw: impl FnOnce(HDC, HDC) -> bool) -> Result<Bgra, RpcError> {
    if width <= 0 || height <= 0 {
        return Err(RpcError::new("capture_failed", "The capture area is empty."));
    }
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, HGDIOBJ(bitmap.0));
        let drawn = draw(memory, screen);
        let result = if drawn {
            read_bitmap(memory, bitmap, width, height)
        } else {
            Err(RpcError::new("capture_failed", "Windows could not render the window."))
        };
        SelectObject(memory, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        result
    }
}

fn is_blank(image: &Bgra) -> bool {
    // Sample a grid; a fully black or fully transparent frame means nothing was rendered.
    let step = ((image.pixels.len() / 4) / 2048).max(1) * 4;
    image.pixels.chunks_exact(4).step_by(step / 4).all(|px| px[0] == 0 && px[1] == 0 && px[2] == 0)
}

fn capture_screen_area(rect: Rect) -> Result<Bgra, RpcError> {
    with_bitmap(rect.width, rect.height, |memory, screen| unsafe {
        BitBlt(memory, 0, 0, rect.width, rect.height, Some(screen), rect.x, rect.y, SRCCOPY | CAPTUREBLT).is_ok()
    })
}

fn capture_window(hwnd: HWND) -> Result<(Bgra, Rect, &'static str), RpcError> {
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return Err(RpcError::new("window_minimized", "The window is minimized. Activate it before capturing."));
    }
    let mut outer = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut outer)? };
    let outer: Rect = outer.into();
    let frame = frame_rect(hwnd);
    // A window that is not per-monitor DPI aware renders itself at its own (smaller)
    // DPI; Windows stretches it on screen. PrintWindow returns the unstretched pixels,
    // so measure the crop in the window's own scale.
    let ratio = render_ratio(hwnd);
    let scaled = |value: i32| (value as f64 * ratio).round() as i32;
    let full = with_bitmap(outer.width, outer.height, |memory, _| unsafe {
        PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
    });
    if let Ok(full) = full {
        if !is_blank(&full) {
            // Crop the invisible resize borders so pixels map onto the visible frame.
            let dx = scaled(frame.x - outer.x).clamp(0, full.width - 1);
            let dy = scaled(frame.y - outer.y).clamp(0, full.height - 1);
            let width = scaled(frame.width).clamp(1, full.width - dx);
            let height = scaled(frame.height).clamp(1, full.height - dy);
            let mut pixels = Vec::with_capacity((width * height * 4) as usize);
            for row in dy..dy + height {
                let start = ((row * full.width + dx) * 4) as usize;
                pixels.extend_from_slice(&full.pixels[start..start + (width * 4) as usize]);
            }
            return Ok((Bgra { width, height, pixels }, frame, "window"));
        }
    }
    Ok((capture_screen_area(frame)?, frame, "screen"))
}

/// Window DPI over monitor DPI: 1.0 for DPI-aware windows, below 1.0 for windows that
/// Windows bitmap-stretches.
fn render_ratio(hwnd: HWND) -> f64 {
    unsafe {
        let window_dpi = GetDpiForWindow(hwnd);
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let (mut dpi_x, mut dpi_y) = (0u32, 0u32);
        if window_dpi == 0 || GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y).is_err() || dpi_x == 0 {
            return 1.0;
        }
        (window_dpi as f64 / dpi_x as f64).min(1.0)
    }
}

fn encode(image: Bgra, max_edge: u32, format: &str, quality: u8) -> Result<(String, u32, u32, &'static str), RpcError> {
    let mut rgb = RgbImage::new(image.width as u32, image.height as u32);
    for (pixel, bgra) in rgb.pixels_mut().zip(image.pixels.chunks_exact(4)) {
        *pixel = image::Rgb([bgra[2], bgra[1], bgra[0]]);
    }
    let longest = rgb.width().max(rgb.height());
    if longest > max_edge && max_edge > 0 {
        let scale = max_edge as f64 / longest as f64;
        let width = ((rgb.width() as f64 * scale).round() as u32).max(1);
        let height = ((rgb.height() as f64 * scale).round() as u32).max(1);
        rgb = image::imageops::resize(&rgb, width, height, FilterType::Triangle);
    }
    let mut bytes = Vec::new();
    let mime = match format {
        "png" => {
            rgb.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
                .map_err(|error| RpcError::new("encode_failed", error.to_string()))?;
            "image/png"
        }
        _ => {
            JpegEncoder::new_with_quality(&mut bytes, quality.clamp(30, 95))
                .encode_image(&rgb)
                .map_err(|error| RpcError::new("encode_failed", error.to_string()))?;
            "image/jpeg"
        }
    };
    Ok((base64::engine::general_purpose::STANDARD.encode(bytes), rgb.width(), rgb.height(), mime))
}

pub fn screenshot(params: Value) -> Result<Value, RpcError> {
    let params: ScreenshotParams = parse(params)?;
    let (image, origin, source) = match params.hwnd {
        Some(hwnd) => capture_window(ensure_window(hwnd)?)?,
        None => {
            let rect = unsafe {
                Rect {
                    x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                    y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                    width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
                }
            };
            (capture_screen_area(rect)?, rect, "screen")
        }
    };
    let (data, width, height, mime) = encode(image, params.max_edge, &params.format, params.quality)?;
    Ok(json!({
        "data": data,
        "mimeType": mime,
        "width": width,
        "height": height,
        // Screen pixels per image pixel: screen = origin + image * scale.
        "scale": origin.width as f64 / width as f64,
        "origin": origin,
        "source": source,
    }))
}
