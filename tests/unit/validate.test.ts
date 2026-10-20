import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

test("artifact validation accepts clean checkouts but rejects changed sources until rebuilt", () => {
  const root = mkdtempSync(join(tmpdir(), "ocu-validate-"));
  const write = (name: string, text: string) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const validate = () => spawnSync(process.execPath, [join(root, "scripts/validate.mjs")], { encoding: "utf8" });
  const old = new Date("2020-01-01"), newer = new Date("2020-01-02");
  try {
    for (const file of ["package.json", "plugin.json", ".claude-plugin/plugin.json"]) write(file, JSON.stringify({ name: "open-cu", version: "0.2.1" }));
    for (const file of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) write(file, JSON.stringify({ plugins: [{ name: "open-cu" }] }));
    write("mcp.json", JSON.stringify({ mcpServers: { "open-cu": { args: ["${PLUGIN_ROOT}/dist/cli.mjs"] } } }));
    write("skills/open-cu/SKILL.md", "---\nname: open-cu\ndescription: This test fixture has a sufficiently long skill description.\n---\n");
    write("src/server.ts", 'export const VERSION = "0.2.1";');
    write("native/windows/src/main.rs", "// fixture source\n");
    write("native/macos/Sources/main.swift", 'let ping = ["version": "0.2.1"]');
    for (const file of ["dist/cli.mjs", "native/windows/bin/ocu-win.exe", "native/macos/bin/ocu-mac"]) { write(file, "fixture artifact"); utimesSync(join(root, file), old, old); }
    for (const file of ["src/server.ts", "native/windows/src/main.rs", "native/macos/Sources/main.swift"]) utimesSync(join(root, file), newer, newer);
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(import.meta.dirname, "../../scripts/validate.mjs"), join(root, "scripts/validate.mjs"));
    git("init", "-q"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    assert.equal(validate().status, 0, "checkout order must not invalidate committed artifacts");
    write("native/windows/src/main.rs", "// changed source\n");
    assert.equal(validate().status, 1, "dirty source needs a rebuild");
    git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "source without artifact");
    assert.equal(validate().status, 1, "a later source-only commit must also fail");
    write("native/windows/bin/ocu-win.exe", "rebuilt artifact");
    assert.equal(validate().status, 0, "a fresh rebuild satisfies the check");
    write("native/macos/Sources/new.swift", "// new untracked source\n");
    assert.equal(validate().status, 1, "untracked sources need a rebuild too");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
