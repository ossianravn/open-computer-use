import assert from "node:assert/strict";
import { test } from "node:test";
import { matchScore, parseWindowId, resolveWindow } from "../../src/apps.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseApprovalMode } from "../../src/config.ts";
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

const prompting = () => ({ ...structuredClone(DEFAULT_CONFIG), approval: "prompt" as const });

test("by default every app is approved without asking", async () => {
  assert.equal(DEFAULT_CONFIG.approval, "all");
  const approvals = new Approvals(structuredClone(DEFAULT_CONFIG), async () => {
    throw new Error("should not ask");
  });
  await approvals.ensure(notepad);
  await approvals.ensure(chrome);
});

test("prompt mode asks once per session and honours an explicit denial", async () => {
  let asked = 0;
  const approvals = new Approvals(prompting(), async () => {
    asked++;
    return "session";
  });
  await approvals.ensure(notepad);
  await approvals.ensure(notepad);
  assert.equal(asked, 1);

  const denying = new Approvals(prompting(), async () => "deny");
  await assert.rejects(denying.ensure(notepad), /declined/);

  const silent = new Approvals(prompting(), async () => undefined);
  await assert.rejects(silent.ensure(notepad), /`open-cu approve notepad.exe`/);
});

test("a dismissed prompt is not reported as the user declining", async () => {
  const dismissed = new Approvals(prompting(), async () => "dismissed");
  const error = await dismissed.ensure(notepad).then(
    () => undefined,
    (reason: Error) => reason,
  );
  assert.ok(error);
  assert.doesNotMatch(error.message, /declined|Do not retry/);
  assert.match(error.message, /closed or could not be shown/);
  assert.match(error.message, /open-cu approval all/);
});

test("approval changes on disk apply without a restart", async () => {
  let onDisk: { approval: "prompt" | "all"; approvedApps: string[] } = { approval: "prompt", approvedApps: [] };
  const approvals = new Approvals(prompting(), async () => undefined, () => onDisk);
  await assert.rejects(approvals.ensure(notepad), /approve/);
  onDisk = { approval: "all", approvedApps: [] };
  await approvals.ensure(notepad);
});

test('approval mode "all" approves every app but not blocked ones', async () => {
  const config = { ...structuredClone(DEFAULT_CONFIG), approval: "all" as const };
  const approvals = new Approvals(config, async () => {
    throw new Error("should not ask");
  });
  await approvals.ensure(notepad);
  await approvals.ensure(chrome);
  assert.ok(blockReason(windowInfo({ processName: "1Password.exe" }), config));
  assert.equal(parseApprovalMode("off"), "all");
  assert.equal(parseApprovalMode("ALL"), "all");
  assert.equal(parseApprovalMode("sometimes"), undefined);
});

test('choosing "every app" in the prompt switches the config to "all"', async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocu-config-"));
  const previous = process.env.OCU_CONFIG;
  process.env.OCU_CONFIG = join(dir, "config.json");
  try {
    let asked = 0;
    const approvals = new Approvals(prompting(), async () => {
      asked++;
      return "all";
    });
    await approvals.ensure(notepad);
    await approvals.ensure(chrome);
    assert.equal(asked, 1);
    assert.equal(JSON.parse(readFileSync(process.env.OCU_CONFIG, "utf8")).approval, "all");
    assert.equal(loadConfig().approval, "all");
  } finally {
    if (previous === undefined) delete process.env.OCU_CONFIG;
    else process.env.OCU_CONFIG = previous;
  }
});
