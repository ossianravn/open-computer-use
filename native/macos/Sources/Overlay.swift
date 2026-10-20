import AppKit

final class Overlay {
  private var panels: [NSPanel] = []
  private var timer: Timer?
  private let enabled = ProcessInfo.processInfo.environment["OCU_OVERLAY"] != "0"

  // All AppKit work belongs to the main run loop; the NDJSON worker never owns UI.
  func show(frame: CGRect, label: String, idleMs: Int) -> Object {
    guard enabled else { return ["ok": true, "enabled": false] }
    DispatchQueue.main.sync {
      self.hideOnMain()
      let mainHeight = NSScreen.screens.first?.frame.height ?? 0
      let cocoaPoint = NSPoint(x: frame.midX, y: mainHeight - frame.midY)
      guard let screen = NSScreen.screens.first(where: { $0.frame.contains(cocoaPoint) }) else {
        return
      }
      let r = screen.frame
      let thickness: CGFloat = 3
      let edges = [
        NSRect(x: r.minX, y: r.minY, width: r.width, height: thickness),
        NSRect(x: r.minX, y: r.maxY - thickness, width: r.width, height: thickness),
        NSRect(x: r.minX, y: r.minY, width: thickness, height: r.height),
        NSRect(x: r.maxX - thickness, y: r.minY, width: thickness, height: r.height),
      ]
      for edge in edges { self.panels.append(self.panel(edge, color: .systemBlue)) }
      let text = NSTextField(
        labelWithString: "open-cu is using \(String(label.prefix(80))) · Esc to stop")
      text.font = .systemFont(ofSize: 13, weight: .medium)
      text.textColor = .white
      text.sizeToFit()
      let width = min(r.width - 40, text.frame.width + 28)
      let banner = self.panel(
        NSRect(x: r.midX - width / 2, y: r.maxY - 56, width: width, height: 32),
        color: NSColor(white: 0.12, alpha: 0.95))
      text.frame = NSRect(x: 14, y: 8, width: width - 28, height: 18)
      banner.contentView?.addSubview(text)
      self.panels.append(banner)
      self.timer = Timer.scheduledTimer(withTimeInterval: Double(idleMs) / 1000, repeats: false) {
        [weak self] _ in self?.hideOnMain()
      }
    }
    return ["ok": true, "enabled": true]
  }

  private func panel(_ rect: NSRect, color: NSColor) -> NSPanel {
    let panel = NSPanel(
      contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: false)
    panel.level = .statusBar
    panel.backgroundColor = color
    panel.isOpaque = false
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.hasShadow = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.sharingType = .none
    panel.orderFrontRegardless()
    return panel
  }

  func hideOnMain() {
    timer?.invalidate()
    timer = nil
    panels.forEach { $0.orderOut(nil) }
    panels.removeAll()
  }
  func hide() -> Object {
    DispatchQueue.main.sync { self.hideOnMain() }
    return ["ok": true, "enabled": enabled]
  }
}
