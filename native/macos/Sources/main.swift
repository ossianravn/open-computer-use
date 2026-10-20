import AppKit
import ApplicationServices

// Native macOS backend. One request and response per line; stdout is protocol only.
// The main thread pumps AppKit and the input guard. AX/RPC runs in request order on
// a worker so blocked accessibility providers cannot freeze the Esc listener.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let windows = Windows()
let guardState = InputGuard()
let overlay = Overlay()
guardState.onStop = { overlay.hideOnMain() }
guardState.start()
let accessibility = Accessibility(windows: windows, guardState: guardState)
let input = Input(windows: windows, guardState: guardState)

func dispatch(_ method: String, _ p: Object) throws -> Any {
  switch method {
  case "ping":
    return [
      "version": "0.2.1", "platform": "macos",
      "permissions": [
        "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
        "inputMonitoring": CGPreflightListenEventAccess(),
      ],
    ] as Object
  case "listWindows": return try windows.list(p)
  case "installedApps": return installedApplications()
  case "launchApp": return try launchApplication(p)
  case "snapshot": return try accessibility.snapshot(p)
  case "elementAction": return try accessibility.action(p)
  case "elementInfo": return try accessibility.info(p)
  case "elementAtPoint": return try accessibility.atPoint(p)
  case "focusedElement": return try accessibility.focused(p)
  case "activateWindow":
    try guardState.check(physical: true)
    let window = try windows.activate(p.integer("hwnd", range: 1...Int(Int32.max)))
    return ["foreground": true, "window": window.json(element: try windows.element(window))]
  case "click": return try input.click(p)
  case "moveMouse": return try input.move(p)
  case "drag": return try input.drag(p)
  case "scroll": return try input.scroll(p)
  case "typeText": return try input.typeText(p)
  case "pressKey": return try input.pressKey(p)
  case "screenshot": return try screenshot(p)
  case "guardStatus": return guardState.status()
  case "clearStop":
    guardState.clear()
    return ["ok": true]
  case "overlayShow":
    try guardState.check()
    let window = try windows.window(p.integer("hwnd", range: 1...Int(Int32.max)))
    return overlay.show(
      frame: window.rect, label: try p.string("label"),
      idleMs: try p.integer("idleMs", default: 15_000, range: 100...300_000))
  case "overlayHide": return overlay.hide()
  default: throw RPCError("unknown_method", "Unknown method \(method).")
  }
}

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    var id: Any = NSNull()
    var response: Object
    do {
      guard let data = line.data(using: .utf8),
        let request = try JSONSerialization.jsonObject(with: data) as? Object,
        let method = request["method"] as? String
      else { throw RPCError("bad_request", "Expected an object with a method and params.") }
      id = request["id"] ?? NSNull()
      guard request["params"] == nil || request["params"] is NSNull || request["params"] is Object
      else { throw RPCError("bad_params", "params must be an object.") }
      response = ["id": id, "result": try dispatch(method, request["params"] as? Object ?? [:])]
    } catch let error as RPCError {
      response = ["id": id, "error": ["code": error.code, "message": error.message]]
    } catch {
      response = [
        "id": id, "error": ["code": "macos_error", "message": error.localizedDescription],
      ]
    }
    do {
      let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([10]))
    } catch {
      FileHandle.standardError.write(Data("ocu-mac: response encoding failed: \(error)\n".utf8))
    }
  }
  exit(0)
}
app.run()
