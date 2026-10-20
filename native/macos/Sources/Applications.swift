import AppKit

func installedApplications() -> [Object] {
  let roots = [
    "/Applications", "/System/Applications", "/System/Library/CoreServices/Applications",
    NSHomeDirectory() + "/Applications",
  ]
  var result: [Object] = []
  var seen = Set<String>()
  func add(_ url: URL) {
    guard let bundle = Bundle(url: url), let executable = bundle.executableURL,
      seen.insert(url.resolvingSymlinksInPath().path).inserted
    else { return }
    let name =
      bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(
        forInfoDictionaryKey: "CFBundleName") as? String
      ?? url.deletingPathExtension().lastPathComponent
    result.append([
      "id": url.path, "name": name, "processName": executable.lastPathComponent,
      "bundleId": bundle.bundleIdentifier ?? "",
    ])
  }
  for root in roots {
    guard
      let enumerator = FileManager.default.enumerator(
        at: URL(fileURLWithPath: root), includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles])
    else { continue }
    for case let url as URL in enumerator {
      // Avoid descending into app bundles and their embedded helpers.
      if url.pathExtension.lowercased() != "app" { continue }
      enumerator.skipDescendants()
      add(url)
    }
  }
  // macOS also runs app bundles from Downloads, mounted volumes and arbitrary
  // folders. Include those already open without crawling the user's filesystem.
  for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
    if let url = app.bundleURL { add(url) }
  }
  return result.sorted {
    ($0["name"] as! String).localizedCaseInsensitiveCompare($1["name"] as! String)
      == .orderedAscending
  }
}

func launchApplication(_ p: Object) throws -> Object {
  let id = try p.string("id")
  guard installedApplications().contains(where: { $0["id"] as? String == id }) else {
    throw RPCError(
      "app_not_found", "Choose an installed application from list_apps(include_installed=true).")
  }
  let result = LaunchResult()
  NSWorkspace.shared.openApplication(
    at: URL(fileURLWithPath: id), configuration: NSWorkspace.OpenConfiguration()
  ) { app, error in result.complete(app, error) }
  guard result.ready.wait(timeout: .now() + 12) == .success else {
    throw RPCError(
      "timeout", "macOS has not finished opening the application. Check list_apps before retrying.")
  }
  return try result.value()
}

private final class LaunchResult: @unchecked Sendable {
  let ready = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var result: Result<Object, Error> = .failure(
    RPCError("launch_failed", "macOS did not start the app."))
  func complete(_ app: NSRunningApplication?, _ error: Error?) {
    lock.lock()
    if let error {
      result = .failure(RPCError("launch_failed", error.localizedDescription))
    } else if let app {
      result = .success(["ok": true, "pid": Int(app.processIdentifier)])
    }
    lock.unlock()
    ready.signal()
  }
  func value() throws -> Object {
    lock.lock()
    defer { lock.unlock() }
    return try result.get()
  }
}
