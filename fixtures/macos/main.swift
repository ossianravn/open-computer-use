import AppKit

// Dedicated disposable test app. Never drive the user's own windows in E2E tests.
final class Fixture: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let name = NSTextField(string: "")
  let notes = NSTextField(string: "")
  let subscribed = NSButton(checkboxWithTitle: "Subscribe to newsletter", target: nil, action: nil)
  let status = NSTextField(labelWithString: "Status: ready")
  let slider = NSSlider(value: 25, minValue: 0, maxValue: 100, target: nil, action: nil)
  let plan = NSPopUpButton(frame: NSRect(x: 20, y: 600, width: 180, height: 28), pullsDown: false)

  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 100, y: 150, width: 640, height: 660),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = CommandLine.arguments.dropFirst().first ?? "OCU macOS Fixture"
    window.isReleasedWhenClosed = false
    let content = window.contentView!
    plan.addItems(withTitles: ["Basic", "Team"])
    plan.setAccessibilityLabel("Plan")
    content.addSubview(plan)
    func field(_ field: NSTextField, _ label: String, _ y: CGFloat) {
      let caption = NSTextField(labelWithString: label)
      caption.frame = NSRect(x: 20, y: y + 2, width: 120, height: 24)
      field.frame = NSRect(x: 145, y: y, width: 460, height: 26)
      field.setAccessibilityLabel(label)
      field.setAccessibilityIdentifier(label.replacingOccurrences(of: " ", with: ""))
      content.addSubview(caption)
      content.addSubview(field)
    }
    field(name, "Full name", 540)
    field(notes, "Notes", 500)
    subscribed.frame = NSRect(x: 20, y: 455, width: 260, height: 28)
    content.addSubview(subscribed)
    slider.frame = NSRect(x: 320, y: 455, width: 280, height: 28)
    slider.setAccessibilityLabel("Volume")
    content.addSubview(slider)
    let buttons: [(String, Selector)] = [
      ("Save draft", #selector(save)), ("Submit", #selector(submit)),
      ("Open dialog", #selector(dialog)), ("Resize window", #selector(resize)),
    ]
    for (i, spec) in buttons.enumerated() {
      let button = NSButton(title: spec.0, target: self, action: spec.1)
      button.frame = NSRect(x: 20 + CGFloat(i) * 150, y: 405, width: 140, height: 32)
      button.setAccessibilityIdentifier(spec.0.replacingOccurrences(of: " ", with: ""))
      content.addSubview(button)
    }
    status.frame = NSRect(x: 20, y: 360, width: 600, height: 30)
    content.addSubview(status)
    let stop = NSButton(title: "Simulate Escape", target: self, action: #selector(stopTest))
    stop.frame = NSRect(x: 450, y: 350, width: 150, height: 32)
    content.addSubview(stop)
    let scroll = NSScrollView(frame: NSRect(x: 20, y: 90, width: 600, height: 250))
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = false
    scroll.setAccessibilityLabel("Reading list")
    let document = NSView(frame: NSRect(x: 0, y: 0, width: 560, height: 1600))
    for i in 0..<50 {
      let line = NSTextField(labelWithString: "Reading row \(i + 1)")
      line.frame = NSRect(x: 10, y: CGFloat(i) * 30, width: 500, height: 25)
      document.addSubview(line)
    }
    scroll.documentView = document
    content.addSubview(scroll)
    let drag = DragSurface(frame: NSRect(x: 20, y: 20, width: 600, height: 50))
    drag.status = status
    content.addSubview(drag)
    let menu = NSMenu()
    let appItem = NSMenuItem()
    menu.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    let edit = NSMenuItem()
    edit.title = "Edit"
    menu.addItem(edit)
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(
      withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = editMenu
    NSApp.mainMenu = menu
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(name)
    NSApp.activate(ignoringOtherApps: true)
  }
  @objc func save() { status.stringValue = "Status: draft saved" }
  @objc func submit() {
    status.stringValue =
      "Status: submitted \(name.stringValue) subscribed=\(subscribed.state == .on)"
  }
  @objc func resize() {
    var r = window.frame
    r.size.width += 40
    window.setFrame(r, display: true)
  }
  @objc func stopTest() {
    // A foreign (untagged) Escape tests the guard without involving real user
    // input. Only emit it while our disposable fixture owns the foreground.
    guard NSApp.isActive else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      guard NSApp.isActive else { return }
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
    }
  }
  @objc func dialog() {
    let alert = NSAlert()
    alert.messageText = "Fixture dialog"
    alert.informativeText = "This dialog belongs only to the test app."
    alert.addButton(withTitle: "Close dialog")
    alert.beginSheetModal(for: window) { _ in self.status.stringValue = "Status: dialog closed" }
  }
}

final class DragSurface: NSView {
  weak var status: NSTextField?
  override var acceptsFirstResponder: Bool { true }
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .image }
  override func accessibilityLabel() -> String? { "Drag surface" }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.systemBlue.withAlphaComponent(0.2).setFill()
    bounds.fill()
  }
  override func mouseDragged(with event: NSEvent) { status?.stringValue = "Status: dragged" }
}

let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
