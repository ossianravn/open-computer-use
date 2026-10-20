import AppKit
import ApplicationServices

typealias Object = [String: Any]

struct RPCError: Error {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
}

extension Dictionary where Key == String, Value == Any {
  func number(_ key: String, default fallback: Double? = nil) throws -> Double {
    if let n = self[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
      n.doubleValue.isFinite
    {
      return n.doubleValue
    }
    if self[key] == nil, let fallback { return fallback }
    throw RPCError("bad_params", "\(key) must be a finite number.")
  }
  func integer(
    _ key: String, default fallback: Int? = nil, range: ClosedRange<Int> = 0...Int(Int32.max)
  ) throws -> Int {
    let n = try number(key, default: fallback.map(Double.init))
    guard n.rounded() == n, n >= Double(range.lowerBound), n <= Double(range.upperBound) else {
      throw RPCError("bad_params", "\(key) must be an integer in \(range).")
    }
    return Int(n)
  }
  func string(_ key: String) throws -> String {
    guard let value = self[key] as? String else {
      throw RPCError("bad_params", "\(key) must be a string.")
    }
    return value
  }
  func point() throws -> CGPoint { CGPoint(x: try number("x"), y: try number("y")) }
}

func rectJSON(_ r: CGRect) -> Object {
  ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}

func requireAccessibility() throws {
  guard AXIsProcessTrusted() else {
    throw RPCError(
      "accessibility_permission",
      "macOS Accessibility access is required. Enable the app running open-cu (your agent or terminal) in System Settings > Privacy & Security > Accessibility, then restart the MCP session. Run open-cu doctor to check access. The helper never grants permissions itself."
    )
  }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
    return nil
  }
  return (value as! AXUIElement)
}

func textAttribute(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  if let text = value as? String { return text }
  if let n = value as? NSNumber { return n.stringValue }
  if let url = value as? URL { return url.absoluteString }
  return ""
}

func boolAttribute(_ element: AXUIElement, _ name: String, default fallback: Bool = false) -> Bool {
  (attribute(element, name) as? NSNumber)?.boolValue ?? fallback
}

func settable(_ element: AXUIElement, _ name: String) -> Bool {
  var result = DarwinBoolean(false)
  return AXUIElementIsAttributeSettable(element, name as CFString, &result) == .success
    && result.boolValue
}

func checkAX(_ error: AXError, _ operation: String) throws {
  guard error != .success else { return }
  switch error {
  case .invalidUIElement:
    throw RPCError(
      "element_unavailable", "The element is no longer available. Refresh the app state.")
  case .cannotComplete:
    throw RPCError(
      "timeout",
      "The app did not complete \(operation). Read its state before retrying; the action may have opened a modal dialog."
    )
  case .apiDisabled:
    try requireAccessibility()
    throw RPCError("accessibility_permission", "The app denied Accessibility access.")
  case .actionUnsupported, .attributeUnsupported, .notImplemented:
    throw RPCError("unsupported", "The app does not support \(operation) through Accessibility.")
  default:
    throw RPCError("accessibility_error", "Accessibility \(operation) failed (\(error.rawValue)).")
  }
}

func setAttribute(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) throws {
  try checkAX(AXUIElementSetAttributeValue(element, name as CFString, value), "setting \(name)")
}

func elementRect(_ element: AXUIElement) -> CGRect {
  var point = CGPoint.zero
  var size = CGSize.zero
  if let v = attribute(element, "AXPosition"), CFGetTypeID(v) == AXValueGetTypeID() {
    AXValueGetValue(v as! AXValue, .cgPoint, &point)
  }
  if let v = attribute(element, "AXSize"), CFGetTypeID(v) == AXValueGetTypeID() {
    AXValueGetValue(v as! AXValue, .cgSize, &size)
  }
  return CGRect(origin: point, size: size)
}
