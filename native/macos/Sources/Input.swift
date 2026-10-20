import AppKit
import ApplicationServices

let injectedEventTag: Int64 = 0x4F43_554D_4143

final class InputGuard {
  private let lock = NSLock()
  private var lastInput: TimeInterval?
  private var lastEscape: TimeInterval?
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  var onStop: (() -> Void)?

  func start() {
    let types: [CGEventType] = [
      .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
    ]
    let mask = types.reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
    tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
      eventsOfInterest: mask,
      callback: { _, type, event, context in
        let guardState = Unmanaged<InputGuard>.fromOpaque(context!).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
          if let tap = guardState.tap { CGEvent.tapEnable(tap: tap, enable: true) }
          return Unmanaged.passUnretained(event)
        }
        if event.getIntegerValueField(.eventSourceUserData) == injectedEventTag {
          return Unmanaged.passUnretained(event)
        }
        guardState.record(
          escape: type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53)
        return Unmanaged.passUnretained(event)
      }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    if let tap {
      source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
    }
  }

  private func record(escape: Bool) {
    lock.lock()
    lastInput = ProcessInfo.processInfo.systemUptime
    if escape { lastEscape = lastInput }
    lock.unlock()
    if escape { onStop?() }
  }

  func status() -> Object {
    lock.lock()
    defer { lock.unlock() }
    let now = ProcessInfo.processInfo.systemUptime
    return [
      "enabled": tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false,
      "lastPhysicalInputMsAgo": lastInput.map { Int((now - $0) * 1000) } as Any? ?? NSNull(),
      "lastEscMsAgo": lastEscape.map { Int((now - $0) * 1000) } as Any? ?? NSNull(),
      "stopped": lastEscape.map { now - $0 < 20 } ?? false,
    ]
  }

  func check(physical: Bool = false) throws {
    let state = status()
    guard state["enabled"] as? Bool == true else {
      throw RPCError(
        "input_guard_unavailable",
        "The macOS Esc/input guard is unavailable. Enable Accessibility and, if requested by macOS, Input Monitoring for the app running open-cu, then restart the MCP session. Actions are disabled until the guard is working."
      )
    }
    if state["stopped"] as? Bool == true {
      throw RPCError(
        "stopped_by_user",
        "The user pressed Esc. Stop and ask how to continue; the stop lasts 20 seconds.")
    }
    if physical, let elapsed = state["lastPhysicalInputMsAgo"] as? Int, elapsed < 700 {
      throw RPCError(
        "user_active", "The user is using the keyboard or mouse. Wait before retrying.")
    }
  }

  func clear() {
    lock.lock()
    lastEscape = nil
    lock.unlock()
  }
}

struct KeyChord {
  let code: CGKeyCode
  let flags: CGEventFlags

  static func modifier(_ value: String) throws -> CGEventFlags {
    switch value.lowercased() {
    case "cmd", "command", "meta", "super", "super_l", "super_r": return .maskCommand
    case "ctrl", "control", "control_l", "control_r": return .maskControl
    case "alt", "option", "alt_l", "alt_r": return .maskAlternate
    case "shift", "shift_l", "shift_r": return .maskShift
    default:
      throw RPCError("bad_key", "Unknown modifier \(value). Use cmd, ctrl, alt/option or shift.")
    }
  }

  static func parse(_ value: String) throws -> KeyChord {
    let parts = value.lowercased().split(separator: "+", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let key = parts.last, !key.isEmpty else {
      throw RPCError("bad_key", "Pass a key, for example Return or cmd+s.")
    }
    var flags: CGEventFlags = []
    for part in parts.dropLast() { flags.formUnion(try modifier(part)) }
    // Virtual key positions for shortcut chords; text entry uses Unicode events.
    let keys: [String: CGKeyCode] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
      "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
      "6": 22, "5": 23,
      "equal": 24, "=": 24, "9": 25, "7": 26, "minus": 27, "-": 27, "8": 28, "0": 29,
      "bracketright": 30,
      "o": 31, "u": 32, "bracketleft": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37,
      "j": 38,
      "apostrophe": 39, "k": 40, "semicolon": 41, "backslash": 42, "comma": 43, "slash": 44,
      "n": 45, "m": 46,
      "period": 47, "tab": 48, "space": 49, "grave": 50, "backspace": 51, "escape": 53, "esc": 53,
      "f17": 64, "f18": 79, "f19": 80, "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100,
      "f9": 101, "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
      "home": 115, "page_up": 116, "pageup": 116, "delete": 117, "del": 117, "f4": 118, "end": 119,
      "f2": 120, "page_down": 121, "pagedown": 121, "f1": 122, "left": 123, "right": 124,
      "down": 125, "up": 126,
    ]
    guard let code = keys[key] else {
      throw RPCError(
        "bad_key",
        "Unknown key \(key). Use type_text for text and supported key names for shortcuts.")
    }
    if (flags.contains(.maskCommand) && ["space", "tab", "grave"].contains(key))
      || (flags.contains([.maskCommand, .maskAlternate]) && ["escape", "esc"].contains(key))
      || (flags.contains([.maskCommand, .maskControl]) && key == "q")
      || (flags.contains(.maskControl)
        && ["up", "down", "left", "right", "f2", "f3", "f8"].contains(key))
    {
      throw RPCError(
        "key_blocked", "This shortcut controls the macOS shell instead of the target app.")
    }
    return KeyChord(code: code, flags: flags)
  }
}

final class Input {
  let windows: Windows
  let guardState: InputGuard
  let source = CGEventSource(stateID: .privateState)
  init(windows: Windows, guardState: InputGuard) {
    self.windows = windows
    self.guardState = guardState
  }

  func prepare(_ p: Object) throws -> AppWindow? {
    try requireAccessibility()
    try guardState.check(physical: true)
    if p["hwnd"] != nil {
      return try windows.activate(p.integer("hwnd", range: 1...Int(Int32.max)))
    }
    return nil
  }

  func check(_ window: AppWindow?, point: CGPoint? = nil) throws {
    try guardState.check(physical: true)
    if let window {
      try windows.assertForeground(window)
      if let point { try windows.assertPoint(point, window: window) }
    }
  }

  func post(_ event: CGEvent?) throws {
    guard let event else {
      throw RPCError("input_failed", "macOS could not create an input event.")
    }
    event.setIntegerValueField(.eventSourceUserData, value: injectedEventTag)
    event.post(tap: .cghidEventTap)
  }

  func modifiers(_ flags: CGEventFlags, down: Bool) throws {
    let keys: [(CGEventFlags, CGKeyCode)] = [
      (.maskCommand, 55), (.maskControl, 59), (.maskAlternate, 58), (.maskShift, 56),
    ]
    var active: CGEventFlags = down ? [] : flags
    for (flag, code) in down ? keys : keys.reversed() {
      guard flags.contains(flag) else { continue }
      if down { active.formUnion(flag) } else { active.subtract(flag) }
      let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
      event?.type = .flagsChanged
      event?.flags = active
      try post(event)
    }
  }

  func cleanup(_ action: () throws -> Void) {
    do { try action() } catch {
      FileHandle.standardError.write(
        Data("ocu-mac: could not release synthetic input: \(error)\n".utf8))
    }
  }

  func mouse(
    _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, flags: CGEventFlags = [],
    count: Int = 1
  ) throws {
    let event = CGEvent(
      mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    event?.flags = flags
    event?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    try post(event)
  }

  func button(_ name: String) throws -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
    switch name {
    case "left": return (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
    case "right": return (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: throw RPCError("bad_params", "button must be left, right or middle.")
    }
  }

  func click(_ p: Object) throws -> Object {
    let point = try p.point()
    let (button, down, up, _) = try button(p["button"] as? String ?? "left")
    let count = try p.integer("count", default: 1, range: 1...3)
    var flags: CGEventFlags = []
    for value in p["modifiers"] as? [String] ?? [] { flags.formUnion(try KeyChord.modifier(value)) }
    let window = try prepare(p)
    try check(window, point: point)
    try modifiers(flags, down: true)
    defer { cleanup { try modifiers(flags, down: false) } }
    let oldPoint = CGEvent(source: nil)?.location
    try mouse(.mouseMoved, point, button)
    for i in 1...count {
      try check(window, point: point)
      try mouse(down, point, button, flags: flags, count: i)
      // Always release a button already pressed, even if Esc arrives meanwhile.
      try mouse(up, point, button, flags: flags, count: i)
      Thread.sleep(forTimeInterval: 0.04)
    }
    if p["restoreCursor"] as? Bool == true, let oldPoint {
      try check(window)
      try mouse(.mouseMoved, oldPoint, .left)
    }
    return ["ok": true, "foreground": window?.app.isActive ?? true]
  }

  func move(_ p: Object) throws -> Object {
    let point = try p.point()
    let window = try prepare(p)
    try check(window, point: point)
    try mouse(.mouseMoved, point, .left)
    return ["ok": true]
  }

  func drag(_ p: Object) throws -> Object {
    guard let fromObject = p["from"] as? Object, let toObject = p["to"] as? Object else {
      throw RPCError("bad_params", "drag needs from and to points.")
    }
    let from = try fromObject.point()
    let to = try toObject.point()
    let steps = try p.integer("steps", default: 24, range: 1...200)
    let (button, down, up, dragged) = try button(p["button"] as? String ?? "left")
    let window = try prepare(p)
    try check(window, point: from)
    try check(window, point: to)
    try mouse(.mouseMoved, from, button)
    try mouse(down, from, button)
    var current = from
    defer { cleanup { try mouse(up, current, button) } }
    for i in 1...steps {
      try check(window)
      current = CGPoint(
        x: from.x + (to.x - from.x) * Double(i) / Double(steps),
        y: from.y + (to.y - from.y) * Double(i) / Double(steps))
      if let window { try windows.assertPoint(current, window: window) }
      try mouse(dragged, current, button)
      Thread.sleep(forTimeInterval: 0.01)
    }
    return ["ok": true, "foreground": window?.app.isActive ?? true]
  }

  func scroll(_ p: Object) throws -> Object {
    let point = try p.point()
    let dx = try p.integer("dx", default: 0, range: -1000...1000)
    let dy = try p.integer("dy", default: 0, range: -1000...1000)
    let window = try prepare(p)
    try check(window, point: point)
    try mouse(.mouseMoved, point, .left)
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: -Int32(dy),
      wheel2: -Int32(dx), wheel3: 0)
    event?.location = point
    try post(event)
    return ["ok": true]
  }

  func pressKey(_ p: Object) throws -> Object {
    let chord = try KeyChord.parse(p.string("key"))
    let count = try p.integer("repeat", default: 1, range: 1...100)
    let window = try prepare(p)
    for _ in 0..<count {
      try check(window)
      try modifiers(chord.flags, down: true)
      defer { cleanup { try modifiers(chord.flags, down: false) } }
      let down = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: true)
      let up = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: false)
      down?.flags = chord.flags
      up?.flags = chord.flags
      try post(down)
      try post(up)
      Thread.sleep(forTimeInterval: 0.02)
    }
    return ["ok": true, "foreground": window?.app.isActive ?? true]
  }

  func typeText(_ p: Object) throws -> Object {
    let text = try p.string("text")
    guard text.utf16.count <= 100_000 else {
      throw RPCError("bad_params", "Type at most 100000 UTF-16 units per call.")
    }
    let window = try prepare(p)
    if let window,
      let focused = elementAttribute(windows.application(window.pid), "AXFocusedUIElement"),
      textAttribute(focused, "AXSubrole") == "AXSecureTextField"
    {
      throw RPCError("input_blocked", "Typing into secure text fields is not allowed.")
    }
    for character in text {
      try check(window)
      let units = Array(String(character).utf16)
      let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
      down?.flags = []
      up?.flags = []
      units.withUnsafeBufferPointer { buffer in
        down?.keyboardSetUnicodeString(
          stringLength: buffer.count, unicodeString: buffer.baseAddress)
        up?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
      }
      try post(down)
      try post(up)
      Thread.sleep(forTimeInterval: 0.003)
    }
    Thread.sleep(forTimeInterval: 0.05)
    let value = window.flatMap {
      elementAttribute(windows.application($0.pid), "AXFocusedUIElement")
    }.map { textAttribute($0, "AXValue") }
    return [
      "ok": true, "foreground": window?.app.isActive ?? true, "characters": text.count,
      "unicodePackets": text.utf16.count,
      "unconfirmed": value?.contains(text) == true ? 0 : text.count,
    ]
  }
}
