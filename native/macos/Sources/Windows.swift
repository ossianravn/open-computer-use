import AppKit
import ApplicationServices

struct AppWindow {
  let id: Int
  let pid: pid_t
  let app: NSRunningApplication
  let rect: CGRect
  let title: String
  let onScreen: Bool

  func json(element: AXUIElement? = nil) -> Object {
    let frame = element.map(elementRect) ?? rect
    let mainScreenHeight = NSScreen.screens.first?.frame.height ?? 0
    let screen = NSScreen.screens.first { screen in
      CGRect(
        x: screen.frame.minX, y: mainScreenHeight - screen.frame.maxY, width: screen.frame.width,
        height: screen.frame.height
      ).intersects(frame)
    }
    return [
      "hwnd": id, "pid": Int(pid),
      "title": element.map { textAttribute($0, "AXTitle") }.flatMap { $0.isEmpty ? nil : $0 }
        ?? title,
      "className": "AXWindow",
      "processName": app.executableURL?.lastPathComponent ?? app.localizedName ?? "pid-\(pid)",
      "bundleId": app.bundleIdentifier ?? "",
      "exePath": app.executableURL?.path as Any? ?? NSNull(),
      "rect": rectJSON(frame),
      "minimized": element.map { boolAttribute($0, "AXMinimized") } ?? !onScreen,
      "maximized": element.map { boolAttribute($0, "AXFullScreen") } ?? false,
      "foreground": app.isActive && (element.map { boolAttribute($0, "AXMain") } ?? true),
      "enabled": true, "owner": NSNull(), "appWindow": true,
      "dpi": 72 * (screen?.backingScaleFactor ?? 1),
    ]
  }
}

final class Windows {
  func inventory() -> [AppWindow] {
    guard
      let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [Object]
    else { return [] }
    return list.compactMap { info in
      guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != getpid(),
        let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy != .prohibited,
        let id = info[kCGWindowNumber as String] as? Int,
        let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
        let bounds = info[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 1,
        rect.height > 1
      else { return nil }
      return AppWindow(
        id: id, pid: pid, app: app, rect: rect,
        title: info[kCGWindowName as String] as? String ?? "",
        onScreen: info[kCGWindowIsOnscreen as String] as? Bool ?? false)
    }
  }

  func window(_ id: Int) throws -> AppWindow {
    guard let window = inventory().first(where: { $0.id == id }) else {
      throw RPCError(
        "window_gone", "Window \(id) has closed or is not available. Call list_apps again.")
    }
    return window
  }

  func application(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    // Chromium and Electron expose web content only after a native AX client asks.
    _ = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return app
  }

  func elements(_ app: AXUIElement) -> [AXUIElement] {
    attribute(app, "AXWindows") as? [AXUIElement] ?? []
  }

  // AX exposes no public CGWindowID attribute. Match inside the owning process by
  // frame, then title; refuse ambiguous matches instead of choosing another window.
  func match(_ window: AppWindow, in candidates: [AXUIElement]) -> AXUIElement? {
    let matching = candidates.filter {
      let r = elementRect($0)
      return abs(r.minX - window.rect.minX) < 3 && abs(r.minY - window.rect.minY) < 3
        && abs(r.width - window.rect.width) < 3 && abs(r.height - window.rect.height) < 3
    }
    if matching.count == 1 { return matching[0] }
    let titled = matching.filter {
      !window.title.isEmpty && textAttribute($0, "AXTitle") == window.title
    }
    return titled.count == 1 ? titled[0] : nil
  }

  func element(_ window: AppWindow) throws -> AXUIElement {
    try requireAccessibility()
    guard let element = match(window, in: elements(application(window.pid))) else {
      throw RPCError(
        "window_unavailable",
        "Cannot uniquely match window \(window.id) to its Accessibility window. Restore the window and read list_apps again."
      )
    }
    return element
  }

  func list(_ params: Object) throws -> [Object] {
    try requireAccessibility()
    var apps: [pid_t: [AXUIElement]] = [:]
    return inventory().compactMap { window in
      if apps[window.pid] == nil { apps[window.pid] = elements(application(window.pid)) }
      let element = match(window, in: apps[window.pid] ?? [])
      if params["includeAll"] as? Bool != true && !window.onScreen && element == nil { return nil }
      return window.json(element: element)
    }
  }

  func activate(_ id: Int) throws -> AppWindow {
    let window = try window(id)
    let element = try element(window)
    if boolAttribute(element, "AXMinimized") {
      try setAttribute(element, "AXMinimized", kCFBooleanFalse)
    }
    guard window.app.activate(options: []) else {
      throw RPCError("input_blocked", "macOS refused to activate the target app.")
    }
    try checkAX(AXUIElementPerformAction(element, "AXRaise" as CFString), "raising the window")
    if settable(element, "AXMain") { try setAttribute(element, "AXMain", kCFBooleanTrue) }
    for _ in 0..<30 {
      if window.app.isActive && boolAttribute(element, "AXMain") { return window }
      Thread.sleep(forTimeInterval: 0.01)
    }
    throw RPCError(
      "input_blocked", "The target window did not become foreground. No input was sent.")
  }

  func assertPoint(_ point: CGPoint, window: AppWindow) throws {
    guard window.rect.contains(point) else {
      throw RPCError("bad_coordinates", "The point is outside the target window.")
    }
    var hit: AXUIElement?
    try checkAX(
      AXUIElementCopyElementAtPosition(
        AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit), "hit testing")
    var pid: pid_t = 0
    guard let hit, AXUIElementGetPid(hit, &pid) == .success, pid == window.pid else {
      throw RPCError("point_occluded", "Another app covers this point. No physical input was sent.")
    }
    let target = try element(window)
    let hitWindow = elementAttribute(hit, "AXWindow") ?? hit
    guard CFEqual(target, hitWindow) else {
      throw RPCError(
        "point_occluded",
        "Another window covers this point. Read the current app state before retrying.")
    }
  }

  func assertForeground(_ window: AppWindow) throws {
    guard window.app.isActive, boolAttribute(try element(window), "AXMain") else {
      throw RPCError("input_blocked", "The foreground window changed. Input stopped.")
    }
  }
}
