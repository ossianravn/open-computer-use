import AppKit
import ApplicationServices

private let roles = [
  "AXWindow": "Window", "AXSheet": "Window", "AXDialog": "Window", "AXButton": "Button",
  "AXCheckBox": "CheckBox", "AXRadioButton": "RadioButton", "AXTextField": "Edit",
  "AXTextArea": "Edit",
  "AXStaticText": "Text", "AXComboBox": "ComboBox", "AXPopUpButton": "ComboBox",
  "AXMenuButton": "SplitButton",
  "AXSlider": "Slider", "AXIncrementor": "Spinner", "AXProgressIndicator": "ProgressBar",
  "AXTabGroup": "Tab", "AXList": "List", "AXOutline": "Tree", "AXRow": "DataItem",
  "AXTable": "Table",
  "AXColumn": "HeaderItem", "AXCell": "DataItem", "AXLink": "Hyperlink", "AXImage": "Image",
  "AXMenuBar": "MenuBar", "AXMenuBarItem": "MenuItem", "AXMenu": "Menu", "AXMenuItem": "MenuItem",
  "AXToolbar": "ToolBar",
  "AXScrollArea": "Pane", "AXScrollBar": "ScrollBar", "AXGroup": "Group", "AXSplitGroup": "Group",
  "AXWebArea": "Document", "AXHeading": "Text", "AXLayoutArea": "Pane", "AXSeparator": "Separator",
]

struct SnapshotCache {
  let snapshotID: Int
  let pid: pid_t
  let elements: [AXUIElement]
}

final class Accessibility {
  let windows: Windows
  let guardState: InputGuard
  private var nextSnapshot = 1
  private var cache: [Int: SnapshotCache] = [:]

  init(windows: Windows, guardState: InputGuard) {
    self.windows = windows
    self.guardState = guardState
  }

  func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(element, &names) == .success ? names as? [String] ?? [] : []
  }

  func node(
    _ element: AXUIElement, id: Int, parent: Int = -1, depth: Int = 0, maxValueLength: Int = 20_000,
    windowRect: CGRect? = nil
  ) -> Object {
    let axRole = textAttribute(element, "AXRole")
    let subrole = textAttribute(element, "AXSubrole")
    let secure = subrole == "AXSecureTextField"
    let role = roles[axRole] ?? "Custom"
    let rect = elementRect(element)
    let names = actionNames(element)
    // AppKit pop-up buttons claim AXValue is settable but may ignore writes.
    // Expose their menu selection path instead, so set_value can verify the choice.
    let valueSettable = !secure && axRole != "AXPopUpButton" && settable(element, "AXValue")
    let expanded = attribute(element, "AXExpanded") as? NSNumber
    var actions: [String] = []
    if names.contains("AXPress") {
      actions.append(role == "CheckBox" ? "toggle" : role == "RadioButton" ? "select" : "invoke")
      if axRole == "AXMenuItem" { actions.append("select") }
      if axRole == "AXPopUpButton" { actions.append("expand") }
    }
    if settable(element, "AXSelected") { actions.append("select") }
    if valueSettable { actions.append("setValue") }
    if settable(element, "AXExpanded") {
      actions.append(expanded?.boolValue == true ? "collapse" : "expand")
    }
    if names.contains("AXScrollToVisible") { actions.append("scrollIntoView") }
    if names.contains(where: { $0.hasPrefix("AXScroll") && $0.hasSuffix("ByPage") })
      || ["AXVerticalScrollBar", "AXHorizontalScrollBar"].contains(where: {
        elementAttribute(element, $0).map { settable($0, "AXValue") } == true
      })
    {
      actions.append("scroll")
    }
    if !secure && ["Edit", "Text", "Document"].contains(role) { actions.append("readText") }
    let title = textAttribute(element, "AXTitle")
    let description = textAttribute(element, "AXDescription")
    let value = secure ? "" : textAttribute(element, "AXValue")
    let label =
      elementAttribute(element, "AXTitleUIElement").map { textAttribute($0, "AXValue") } ?? ""
    let name =
      !title.isEmpty
      ? title
      : !description.isEmpty ? description : !label.isEmpty ? label : role == "Text" ? value : ""
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    var result: Object = [
      "id": id, "parent": parent, "depth": depth, "runtimeId": "ax:\(pid):\(CFHash(element))",
      "role": role,
      "localizedRole": axRole == "AXHeading"
        ? "heading" : textAttribute(element, "AXRoleDescription"),
      "name": String(name.prefix(maxValueLength)), "value": String(value.prefix(maxValueLength)),
      "automationId": textAttribute(element, "AXIdentifier"), "className": axRole,
      "rect": rectJSON(rect), "enabled": boolAttribute(element, "AXEnabled", default: true),
      "offscreen": boolAttribute(element, "AXHidden")
        || (windowRect.map { rect.width > 0 && rect.height > 0 && !$0.intersects(rect) } ?? false),
      "focused": boolAttribute(element, "AXFocused"),
      "focusable": !secure && settable(element, "AXFocused"),
      "actions": Array(Set(actions)).sorted(), "readOnly": !valueSettable,
      "helpText": secure
        ? "Secure text field; contents and actions are unavailable."
        : textAttribute(element, "AXHelp"),
    ]
    if role == "Hyperlink" { result["value"] = textAttribute(element, "AXURL") }
    if role == "CheckBox" {
      result["toggleState"] = value == "1" ? "on" : value == "0" ? "off" : "indeterminate"
    }
    if let expanded { result["expandState"] = expanded.boolValue ? "expanded" : "collapsed" }
    if axRole == "AXPopUpButton" {
      let hasMenu = (attribute(element, "AXChildren") as? [AXUIElement] ?? []).contains {
        textAttribute($0, "AXRole") == "AXMenu"
      }
      result["expandState"] = hasMenu ? "expanded" : "collapsed"
    }
    if let selected = attribute(element, "AXSelected") as? NSNumber {
      result["selected"] = selected.boolValue
    }
    if role == "RadioButton" { result["selected"] = value == "1" }
    if ["Slider", "Spinner", "ProgressBar", "ScrollBar"].contains(role), let current = Double(value)
    {
      let range: [String: Double] = [
        "value": current, "min": Double(textAttribute(element, "AXMinValue")) ?? 0,
        "max": Double(textAttribute(element, "AXMaxValue")) ?? 1,
      ]
      result["range"] = range
    }
    return result
  }

  func snapshot(_ p: Object) throws -> Object {
    let start = ProcessInfo.processInfo.systemUptime
    let id = try p.integer("hwnd", range: 1...Int(Int32.max))
    let window = try windows.window(id)
    let root = try windows.element(window)
    let maxNodes = try p.integer("maxNodes", default: 5000, range: 1...50_000)
    let maxDepth = try p.integer("maxDepth", default: 60, range: 0...200)
    let maxValue = try p.integer("maxValueLength", default: 20_000, range: 0...1_000_000)
    var nodes: [Object] = []
    var elements: [AXUIElement] = []
    var seen = Set<AXUIElement>()
    var truncated = false
    func visit(_ element: AXUIElement, parent: Int, depth: Int, menu: Bool = false) {
      guard seen.insert(element).inserted else { return }
      if nodes.count >= maxNodes || ProcessInfo.processInfo.systemUptime - start > 20 {
        truncated = true
        return
      }
      let index = elements.count
      let entry = node(
        element, id: index, parent: parent, depth: depth, maxValueLength: maxValue,
        windowRect: menu ? nil : window.rect)
      if parent != -1 && p["includeOffscreen"] as? Bool != true
        && entry["offscreen"] as? Bool == true
      {
        return
      }
      elements.append(element)
      nodes.append(entry)
      let children = attribute(element, "AXChildren") as? [AXUIElement] ?? []
      if depth >= maxDepth {
        if !children.isEmpty { truncated = true }
        return
      }
      for (ordinal, child) in children.enumerated() {
        // The first item is the system Apple menu, outside this app's scope.
        if menu && textAttribute(element, "AXRole") == "AXMenuBar" && ordinal == 0 { continue }
        if nodes.count >= maxNodes || ProcessInfo.processInfo.systemUptime - start > 20 {
          truncated = true
          break
        }
        visit(child, parent: index, depth: depth + 1, menu: menu)
      }
    }
    visit(root, parent: -1, depth: 0)
    // Menus live under the application on macOS; include them in the same window
    // tree so File/Edit and open menu items remain reachable through the MCP API.
    if let menu = elementAttribute(windows.application(window.pid), "AXMenuBar") {
      visit(menu, parent: 0, depth: 1, menu: true)
    }
    let snapshotID = nextSnapshot
    nextSnapshot += 1
    let live = Set(windows.inventory().map(\.id))
    cache = cache.filter { live.contains($0.key) }
    cache[id] = SnapshotCache(snapshotID: snapshotID, pid: window.pid, elements: elements)
    return [
      "snapshotId": snapshotID, "window": window.json(element: root), "nodes": nodes,
      "truncated": truncated,
      "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - start) * 1000),
    ]
  }

  func resolve(_ p: Object) throws -> (AppWindow, AXUIElement) {
    try requireAccessibility()
    let window = try windows.window(p.integer("hwnd", range: 1...Int(Int32.max)))
    guard let cached = cache[window.id], cached.pid == window.pid else {
      throw RPCError("stale_snapshot", "Read the app state before acting on an element.")
    }
    if p["snapshotId"] != nil, try p.integer("snapshotId") != cached.snapshotID {
      throw RPCError("stale_snapshot", "The snapshot was replaced. Read the app state again.")
    }
    let id = try p.integer("elementId")
    guard id < cached.elements.count else {
      throw RPCError("element_unavailable", "The element is not in the latest snapshot.")
    }
    let element = cached.elements[id]
    var role: CFTypeRef?
    try checkAX(
      AXUIElementCopyAttributeValue(element, "AXRole" as CFString, &role), "reading the element")
    return (window, element)
  }

  func info(_ p: Object) throws -> Object {
    let (window, element) = try resolve(p)
    let rect = elementRect(element)
    return [
      "node": node(element, id: try p.integer("elementId"), windowRect: window.rect),
      "clickablePoint": rect.width > 0 && rect.height > 0
        ? ["x": rect.midX, "y": rect.midY] as Any : NSNull(),
    ]
  }

  func detached(_ element: AXUIElement) -> Object {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    let parent = elementAttribute(element, "AXWindow") ?? element
    let window = windows.inventory().first {
      $0.pid == pid && windows.match($0, in: [parent]) != nil
    }
    var result: Object = [
      "node": node(element, id: -1), "topWindow": window?.id as Any? ?? NSNull(),
    ]
    if let window, let id = cache[window.id]?.elements.firstIndex(where: { CFEqual($0, element) }) {
      result["elementId"] = id
    }
    return result
  }

  func atPoint(_ p: Object) throws -> Object {
    try requireAccessibility()
    let point = try p.point()
    var element: AXUIElement?
    try checkAX(
      AXUIElementCopyElementAtPosition(
        AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element), "hit testing")
    guard let element else {
      throw RPCError("element_unavailable", "No accessible element at this point.")
    }
    return detached(element)
  }

  func focused(_ p: Object) throws -> Object {
    try requireAccessibility()
    let app: AXUIElement
    if p["hwnd"] != nil {
      app = windows.application(
        try windows.window(p.integer("hwnd", range: 1...Int(Int32.max))).pid)
    } else if let focused = elementAttribute(AXUIElementCreateSystemWide(), "AXFocusedApplication")
    {
      app = focused
    } else {
      throw RPCError("element_unavailable", "No focused application.")
    }
    guard let element = elementAttribute(app, "AXFocusedUIElement") else {
      throw RPCError("element_unavailable", "No focused element.")
    }
    return detached(element)
  }

  func action(_ p: Object) throws -> Object {
    let (_, element) = try resolve(p)
    let action = try p.string("action")
    if action != "readText" { try guardState.check() }
    guard textAttribute(element, "AXSubrole") != "AXSecureTextField" else {
      throw RPCError("input_blocked", "Secure text fields cannot be read or changed.")
    }
    if action == "readText" {
      let length = try p.integer("maxLength", default: 20_000, range: 0...1_000_000)
      return ["ok": true, "text": String(textAttribute(element, "AXValue").prefix(length))]
    }
    if action == "setValue" {
      let value = try p.string("value")
      guard settable(element, "AXValue") else {
        throw RPCError("not_settable", "This element has no settable Accessibility value.")
      }
      if ["AXSlider", "AXIncrementor", "AXScrollBar"].contains(textAttribute(element, "AXRole")) {
        guard let number = Double(value), number.isFinite else {
          throw RPCError("bad_params", "This control needs a numeric value.")
        }
        try setAttribute(element, "AXValue", NSNumber(value: number))
      } else {
        try setAttribute(element, "AXValue", value as CFString)
      }
      return ["ok": true, "value": textAttribute(element, "AXValue")]
    }
    if action == "focus" {
      try setAttribute(element, "AXFocused", kCFBooleanTrue)
      return ["ok": true]
    }
    if ["select", "addToSelection", "removeFromSelection"].contains(action),
      textAttribute(element, "AXRole") != "AXMenuItem", settable(element, "AXSelected")
    {
      try setAttribute(
        element, "AXSelected", action == "removeFromSelection" ? kCFBooleanFalse : kCFBooleanTrue)
      return ["ok": true]
    }
    if (action == "expand" || action == "collapse") && settable(element, "AXExpanded") {
      try setAttribute(element, "AXExpanded", action == "expand" ? kCFBooleanTrue : kCFBooleanFalse)
      return ["ok": true]
    }
    if action == "scroll" { return try scroll(element, p) }
    let native: String
    switch action {
    case "invoke", "toggle", "select", "defaultAction": native = "AXPress"
    case "expand" where textAttribute(element, "AXRole") == "AXPopUpButton": native = "AXPress"
    case "collapse" where textAttribute(element, "AXRole") == "AXPopUpButton":
      let menu = (attribute(element, "AXChildren") as? [AXUIElement] ?? []).first {
        textAttribute($0, "AXRole") == "AXMenu"
      }
      if let menu {
        try checkAX(AXUIElementPerformAction(menu, "AXCancel" as CFString), "closing the menu")
      }
      return ["ok": true]
    case "scrollIntoView": native = "AXScrollToVisible"
    case "showContextMenu": native = "AXShowMenu"
    default: throw RPCError("unsupported", "Unsupported Accessibility action \(action).")
    }
    // Some AXPress providers hold the call open until a modal closes. Let the
    // request return pending, while preserving the element on the worker thread.
    let wait = try p.integer("waitMs", default: 700, range: 0...5000)
    let result = ActionResult()
    DispatchQueue.global().async {
      result.complete(AXUIElementPerformAction(element, native as CFString))
    }
    if result.ready.wait(timeout: .now() + .milliseconds(wait)) == .timedOut {
      return ["ok": true, "pending": true]
    }
    try checkAX(result.value(), native)
    return ["ok": true]
  }

  private func scroll(_ element: AXUIElement, _ p: Object) throws -> Object {
    let direction = try p.string("direction")
    guard ["up", "down", "left", "right"].contains(direction) else {
      throw RPCError("bad_params", "Invalid scroll direction.")
    }
    let amount = try p.integer("amount", default: 1, range: 1...100)
    let action = "AXScroll\(direction.capitalized)ByPage"
    let names = actionNames(element)
    var remaining = amount
    if p["page"] as? Bool != false && names.contains(action) {
      for _ in 0..<amount {
        try guardState.check()
        let error = AXUIElementPerformAction(element, action as CFString)
        // AppKit advertises page actions even on providers that implement
        // only the scrollbar's AXValue. Stay within Accessibility here.
        if error == .actionUnsupported || error == .attributeUnsupported || error == .notImplemented
        {
          break
        }
        try checkAX(error, action)
        remaining -= 1
      }
    }
    if remaining > 0 {
      let attr =
        ["up", "down"].contains(direction) ? "AXVerticalScrollBar" : "AXHorizontalScrollBar"
      guard let bar = elementAttribute(element, attr), settable(bar, "AXValue") else {
        throw RPCError(
          "unsupported",
          "The control has no Accessibility scrollbar for \(direction). Use screenshot coordinates to scroll with the mouse wheel."
        )
      }
      let current = Double(textAttribute(bar, "AXValue")) ?? 0
      let minValue = Double(textAttribute(bar, "AXMinValue")) ?? 0
      let maxValue = Double(textAttribute(bar, "AXMaxValue")) ?? 1
      let sign = ["up", "left"].contains(direction) ? -1.0 : 1.0
      let step = (p["page"] as? Bool == false ? 0.05 : 0.2) * (maxValue - minValue)
      try setAttribute(
        bar, "AXValue",
        NSNumber(value: min(maxValue, max(minValue, current + sign * Double(remaining) * step))))
    }
    return ["ok": true]
  }
}

private final class ActionResult: @unchecked Sendable {
  let ready = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var error = AXError.failure
  func complete(_ value: AXError) {
    lock.lock()
    error = value
    lock.unlock()
    ready.signal()
  }
  func value() -> AXError {
    lock.lock()
    defer { lock.unlock() }
    return error
  }
}
