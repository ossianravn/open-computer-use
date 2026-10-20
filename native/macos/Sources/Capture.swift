import AppKit
import ScreenCaptureKit

private final class CaptureResult<T>: @unchecked Sendable {
  let ready = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var result: Result<T, Error>?
  func complete(_ value: T?, _ error: Error?) {
    lock.lock()
    if let error {
      result = .failure(error)
    } else if let value {
      result = .success(value)
    } else {
      result = .failure(RPCError("capture_failed", "ScreenCaptureKit returned no image."))
    }
    lock.unlock()
    ready.signal()
  }
  func wait() throws -> T {
    guard ready.wait(timeout: .now() + 8) == .success else {
      throw RPCError("timeout", "ScreenCaptureKit did not respond within 8 seconds.")
    }
    lock.lock()
    defer { lock.unlock() }
    return try result!.get()
  }
}

func screenshot(_ p: Object) throws -> Object {
  guard CGPreflightScreenCaptureAccess() else {
    throw RPCError(
      "screen_recording_permission",
      "macOS Screen Recording access is required for screenshots. Enable the app running open-cu in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the MCP session. Accessibility reads can still work without screenshots."
    )
  }
  let edge = try p.integer("maxEdge", default: 1600, range: 64...8192)
  let format = p["format"] as? String ?? "jpeg"
  guard ["jpeg", "png"].contains(format) else {
    throw RPCError("bad_params", "format must be jpeg or png.")
  }
  let quality = try p.integer("quality", default: 80, range: 1...100)
  let contentResult = CaptureResult<SCShareableContent>()
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) {
    contentResult.complete($0, $1)
  }
  let content = try contentResult.wait()
  let filter: SCContentFilter
  let frame: CGRect
  let source: String
  if p["hwnd"] != nil {
    let id = try p.integer("hwnd", range: 1...Int(Int32.max))
    guard let window = content.windows.first(where: { $0.windowID == id }) else {
      throw RPCError(
        "window_gone", "Window \(id) is not available for capture. Restore it and retry.")
    }
    filter = SCContentFilter(desktopIndependentWindow: window)
    frame = window.frame
    source = "window"
  } else {
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
      throw RPCError("capture_failed", "No main display is available.")
    }
    filter = SCContentFilter(
      display: display,
      excludingApplications: content.applications.filter { $0.processID == getpid() },
      exceptingWindows: [])
    frame = CGDisplayBounds(display.displayID)
    source = "screen"
  }
  guard frame.width > 0, frame.height > 0 else {
    throw RPCError("capture_failed", "The capture area is empty.")
  }
  let factor = min(2, Double(edge) / max(frame.width, frame.height))
  let config = SCStreamConfiguration()
  config.width = max(1, Int((frame.width * factor).rounded()))
  config.height = max(1, Int((frame.height * factor).rounded()))
  config.showsCursor = false
  config.scalesToFit = true
  config.ignoreShadowsSingleWindow = true
  config.shouldBeOpaque = true
  let imageResult = CaptureResult<CGImage>()
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) {
    imageResult.complete($0, $1)
  }
  let image = try imageResult.wait()
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard
    let data = bitmap.representation(
      using: format == "png" ? .png : .jpeg,
      properties: [.compressionFactor: Double(quality) / 100])
  else { throw RPCError("capture_failed", "Could not encode the screenshot.") }
  return [
    "data": data.base64EncodedString(), "mimeType": format == "png" ? "image/png" : "image/jpeg",
    "width": image.width, "height": image.height, "scale": frame.width / Double(image.width),
    "origin": rectJSON(frame), "source": source,
  ]
}
