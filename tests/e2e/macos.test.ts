import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HelperClient } from "../../src/helper.ts";
import type { RawNode } from "../../src/protocol.ts";

const macos = process.platform === "darwin";
const root = join(import.meta.dirname, "../..");
const title = `OCU macOS E2E ${process.pid}`;
let dir: string, fixture: ChildProcess | undefined, client: Client, helper: HelperClient, hwnd: number;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: { window: hwnd, ...args } });
  const parts = result.content as { type: string; text?: string; data?: string }[];
  return { isError: !!result.isError, text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n"), images: parts.filter((p) => p.type === "image") };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const result = await call(name, args);
  assert.equal(result.isError, false, result.text);
  return result;
}

before(async () => {
  if (!macos) return;
  helper = new HelperClient(join(root, "native/macos/bin/ocu-mac"));
  const ping = await helper.call("ping", {});
  assert.equal(ping.permissions?.accessibility, true, "macOS E2E needs Accessibility permission for the terminal/agent running it.");
  assert.equal(ping.permissions?.screenRecording, true, "macOS E2E needs Screen Recording permission.");
  assert.equal((await helper.call("guardStatus", {})).enabled, true, "macOS E2E requires the Esc guard.");
  dir = mkdtempSync(join(tmpdir(), "ocu-macos-e2e-"));
  const bundle = join(dir, "OCU Fixture.app/Contents");
  mkdirSync(join(bundle, "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>OCUFixture</string><key>CFBundleIdentifier</key><string>org.open-cu.fixture</string><key>CFBundleName</key><string>OCU Fixture</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  execFileSync("xcrun", ["swiftc", "-module-cache-path", join(tmpdir(), "ocu-swift-module-cache"), join(root, "fixtures/macos/main.swift"), "-o", join(bundle, "MacOS/OCUFixture")]);
  fixture = spawn(join(bundle, "MacOS/OCUFixture"), [title], { stdio: "ignore" });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ approval: "all", settleMs: 100, overlay: false }));
  client = new Client({ name: "ocu-macos-e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "src/cli.ts"), "mcp"],
    env: { ...process.env, OCU_CONFIG: join(dir, "config.json") } as Record<string, string>, stderr: "inherit" }));
  for (let i = 0; i < 40; i++) {
    const found = (await helper.call("listWindows", {})).find((w) => w.pid === fixture?.pid && w.title === title);
    if (found) { hwnd = found.hwnd; await sleep(800); return; }
    await sleep(250);
  }
  throw new Error("The isolated AppKit fixture did not appear.");
});

after(async () => { await client?.close(); helper?.close(); fixture?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test("macOS MCP lists and reads the dedicated fixture", { skip: !macos }, async () => {
  assert.ok((await ok("list_apps")).text.includes(title));
  const state = await ok("get_app_state");
  assert.match(state.text, /text field .*Full name/);
  assert.match(state.text, /button Submit/);
  assert.match(state.text, /checkbox .*Subscribe to newsletter/);
});

test("macOS discovers app bundles and opens the fixture through launch_app", { skip: !macos }, async () => {
  const installed = await helper.call("installedApps", {});
  assert.ok(installed.some((app) => app.bundleId === "org.open-cu.fixture"));
  const launched = await ok("launch_app", { app: "org.open-cu.fixture" });
  assert.ok(launched.text.includes(String(hwnd)), launched.text);
  const blocked = await call("launch_app", { app: "Terminal" });
  assert.equal(blocked.isError, true); assert.match(blocked.text, /app_blocked/);
});

test("macOS AX actions, setValue, batches, and stable indices", { skip: !macos }, async () => {
  const before = await ok("get_app_state");
  const save = before.text.match(/^(\d+) button Save draft/m);
  assert.ok(save, before.text);
  const batch = await ok("perform_actions", { actions: [
    { action: "set_value", target: "Full name", value: "Grace Hopper" },
    { action: "click", target: "Subscribe to newsletter" },
    { action: "click", target: "Submit" },
  ] });
  assert.match(batch.text, /Status: submitted Grace Hopper subscribed=true/);
  assert.match(batch.text, /macOS Accessibility/);
  const saved = await ok("click", { element_index: save[1] });
  assert.match(saved.text, /Status: draft saved/);
  const missing = await call("click", { element_index: 99999 });
  assert.match(missing.text, /element_not_found/);
});

test("macOS Unicode typing and Command shortcuts stay in the fixture", { skip: !macos }, async () => {
  const text = 'Ærø @{}[]$€ "q" ~^´ é ü — 🙂';
  await ok("type_text", { target: "Notes", text });
  assert.ok((await ok("get_app_state")).text.includes(text));
  await ok("press_key", { key: "cmd+a" });
  await ok("type_text", { text: "Replaced" });
  assert.match((await ok("get_app_state")).text, /Notes, Value: Replaced/);
  const denied = await call("press_key", { key: "cmd+space" });
  assert.equal(denied.isError, true); assert.match(denied.text, /key_blocked/);
  assert.equal((await helper.call("guardStatus", {})).stopped, false);
});

test("macOS snapshots reject stale ids and secondary actions read text", { skip: !macos }, async () => {
  const first = await helper.call("snapshot", { hwnd });
  const field = first.nodes.find((n) => n.name === "Notes" && n.role === "Edit")!;
  const another = new HelperClient(join(root, "native/macos/bin/ocu-mac"));
  try {
    const separate = await another.call("snapshot", { hwnd });
    assert.equal(separate.nodes.find((n) => n.name === "Notes" && n.role === "Edit")?.runtimeId, field.runtimeId, "element identity must survive helper restarts for CLI calls");
  } finally { another.close(); }
  await helper.call("snapshot", { hwnd });
  await assert.rejects(helper.call("elementAction", { hwnd, elementId: field.id, snapshotId: first.snapshotId, action: "readText" }), /snapshot was replaced/);
  const state = await ok("get_app_state");
  const index = state.text.match(/^(\d+) text field .*Notes,/m)?.[1];
  assert.ok(index, state.text);
  const read = await ok("perform_secondary_action", { element_index: index, action: "Read Text" });
  assert.match(read.text, /Replaced/);
});

test("macOS screenshots map to physical clicks and drags", { skip: !macos }, async () => {
  const noShot = await call("click", { x: 10, y: 10 });
  assert.match(noShot.text, /no_screenshot/);
  const screen = await ok("get_app_state", { include_screenshot: true });
  assert.equal(screen.images.length, 1);
  const dimensions = screen.text.match(/Screenshot: (\d+)×(\d+) px/);
  assert.ok(dimensions, screen.text);
  const raw = await helper.call("snapshot", { hwnd });
  const factor = Number(dimensions[1]) / raw.window.rect.width;
  const point = (node: RawNode, x = 0.5) => ({ x: Math.round((node.rect.x - raw.window.rect.x + node.rect.width * x) * factor), y: Math.round((node.rect.y - raw.window.rect.y + node.rect.height / 2) * factor) });
  const submit = raw.nodes.find((n) => n.name === "Submit" && n.role === "Button")!;
  assert.ok(submit);
  assert.match((await ok("click", point(submit))).text, /Status: submitted/);
  const surface = raw.nodes.find((n) => n.name === "Drag surface")!;
  assert.ok(surface);
  const from = point(surface, 0.2), to = point(surface, 0.8);
  const dragged = await ok("drag", { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y });
  assert.match(dragged.text, /Status: dragged/);
  await ok("click", { target: "Resize window" });
  const stale = await call("click", point(submit));
  assert.match(stale.text, /screenshot_stale/);
});

test("macOS AX scrolling, numeric values, and sheets", { skip: !macos }, async () => {
  await ok("set_value", { target: "Plan", value: "Team" });
  await ok("set_value", { target: "Volume", value: "70" });
  const raw = await helper.call("snapshot", { hwnd });
  assert.equal(raw.nodes.find((n) => n.name === "Plan")?.value, "Team");
  assert.equal(raw.nodes.find((n) => n.name === "Volume")?.range?.value, 70);
  const scrollValue = raw.nodes.find((n) => n.role === "ScrollBar")?.value;
  await ok("scroll", { target: "Reading list", direction: "up", pages: 1 });
  const scrolled = await helper.call("snapshot", { hwnd });
  assert.notEqual(scrolled.nodes.find((n) => n.role === "ScrollBar")?.value, scrollValue, "scrolling must change the scrollbar value");
  await ok("click", { target: "Open dialog" });
  const dialog = await ok("get_app_state");
  assert.match(dialog.text, /Fixture dialog/);
  await ok("click", { target: "Close dialog", click_method: "physical" });
  assert.match((await ok("get_app_state")).text, /Status: dialog closed/);
});

test("macOS overlay does not appear in inventory or intercept fixture clicks", { skip: !macos }, async () => {
  assert.equal((await helper.call("overlayShow", { hwnd, label: "OCU test fixture", idleMs: 300 })).enabled, true);
  const windows = await helper.call("listWindows", { includeAll: true });
  assert.equal(windows.some((w) => w.processName === "ocu-mac"), false);
  await ok("click", { target: "Save draft", click_method: "physical" });
  await helper.call("overlayHide", {});
});

test("macOS foreign Escape latches the guard and blocks further actions", { skip: !macos }, async () => {
  await helper.call("activateWindow", { hwnd });
  await ok("click", { target: "Simulate Escape" });
  await sleep(100);
  assert.equal((await helper.call("guardStatus", {})).stopped, true);
  const stopped = await call("click", { target: "Save draft" });
  assert.equal(stopped.isError, true); assert.match(stopped.text, /stopped_by_user/);
  // Intentionally last: do not clear or override a latched stop. Teardown only.
});
