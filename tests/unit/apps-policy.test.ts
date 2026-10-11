import assert from "node:assert/strict";
import { test } from "node:test";
import { matchScore, parseWindowId, resolveWindow } from "../../src/apps.ts";
import { DEFAULT_CONFIG } from "../../src/config.ts";
import { ToolError } from "../../src/errors.ts";
import { Approvals, assertKeyAllowed, blockReason } from "../../src/policy.ts";
import { windowInfo } from "./helpers.ts";

const notepad = windowInfo({ hwnd: 1, pid: 10, processName: "Notepad.exe", title: "notes.txt - Notepad" });
const chrome = windowInfo({ hwnd: 2, pid: 20, processName: "chrome.exe", title: "Inbox - Google Chrome" });
const chromeDialog = windowInfo({ hwnd: 3, pid: 20, processName: "chrome.exe", title: "Save As", owner: 2 });

test("apps match by alias, executable, title and pid", () => {
  assert.equal(matchScore(notepad, "notepad"), 100);
  assert.equal(matchScore(notepad, "notepad.exe"), 100);
  assert.equal(matchScore(chrome, "google chrome"), 100);
  assert.equal(matchScore(chrome, "inbox"), 70);
  assert.equal(matchScore(chrome, "20"), 100);
  assert.equal(matchScore(chrome, "excel"), 0);
});

test("window ids parse from decimal and hex", () => {
  assert.equal(parseWindowId("0x1A"), 26);
  assert.equal(parseWindowId("26"), 26);
  assert.equal(parseWindowId(26), 26);
  assert.throws(() => parseWindowId("nope"), ToolError);
});

test("a modal dialog takes over from its blocked owner", () => {
  const blocked = { ...chrome, enabled: false };
  const resolved = resolveWindow([notepad, blocked, chromeDialog], [notepad, blocked], "chrome");
  assert.equal(resolved.window.hwnd, 3);
  assert.match(resolved.note ?? "", /Save As/);
});

test("an explicit window must belong to the named app", () => {
  assert.throws(() => resolveWindow([notepad, chrome], [notepad, chrome], "chrome", 1), /does not belong/);
  assert.equal(resolveWindow([notepad, chrome], [notepad, chrome], undefined, 1).window.hwnd, 1);
});

test("terminals, password managers and agent apps are blocked", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  assert.ok(blockReason(windowInfo({ processName: "WindowsTerminal.exe" }), config));
  assert.ok(blockReason(windowInfo({ processName: "pwsh.exe", className: "ConsoleWindowClass" }), config));
  assert.ok(blockReason(windowInfo({ processName: "1Password.exe" }), config));
  assert.ok(blockReason(windowInfo({ processName: "Claude.exe" }), config));
  // A GUI window owned by a shell process is not a terminal.
  assert.equal(blockReason(windowInfo({ processName: "pwsh.exe", className: "WindowsForms10.Window.8.app" }), config), undefined);
  assert.equal(blockReason(notepad, config), undefined);
});

test("Windows-key chords are refused", () => {
  assert.throws(() => assertKeyAllowed("super+r"), /Windows-key/);
  assert.throws(() => assertKeyAllowed("ctrl+alt+delete"));
  assert.doesNotThrow(() => assertKeyAllowed("ctrl+s"));
});

test("approval asks the user once per session and honours a denial", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  let asked = 0;
  const approvals = new Approvals(config, async () => {
    asked++;
    return "session";
  });
  await approvals.ensure(notepad);
  await approvals.ensure(notepad);
  assert.equal(asked, 1);

  const denying = new Approvals(structuredClone(DEFAULT_CONFIG), async () => "deny");
  await assert.rejects(denying.ensure(notepad), /declined/);

  const silent = new Approvals(structuredClone(DEFAULT_CONFIG), async () => undefined);
  await assert.rejects(silent.ensure(notepad), /open-computer-use approve notepad.exe/);
});
