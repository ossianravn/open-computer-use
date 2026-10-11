// End-to-end: a real MCP client drives the server over stdio against the WinForms
// fixture (fixtures/windows/fixture.ps1). Windows only; needs `npm run build:native`.
// Set OCU_E2E_JEV=1 to also exercise Jev (needs TYPESAFE_API_KEY or JEV_9000_ENV_FILE).

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const windows = process.platform === "win32";
const title = `OCU E2E ${process.pid}`;
const root = join(import.meta.dirname, "..", "..");
const withJev = process.env.OCU_E2E_JEV === "1";

let fixture: ChildProcess | undefined;
let client: Client;
const prompts: string[] = [];

type Content = { type: string; text?: string; data?: string };

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; images: number }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
  return {
    text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    isError: !!result.isError,
    images: result.content.filter((part) => part.type === "image").length,
  };
}

before(async () => {
  if (!windows) return;
  fixture = spawn("pwsh", ["-NoProfile", "-File", join(root, "fixtures", "windows", "fixture.ps1"), "-Title", title], { stdio: "ignore" });
  const configDir = mkdtempSync(join(tmpdir(), "ocu-e2e-"));
  const configFile = join(configDir, "config.json");
  writeFileSync(configFile, JSON.stringify({ approval: "prompt" }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src", "cli.ts"), "mcp", ...(withJev ? ["--jev"] : [])],
    env: { ...process.env, OCU_CONFIG: configFile } as Record<string, string>,
    stderr: "inherit",
  });
  client = new Client({ name: "ocu-e2e", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts.push(request.params.message);
    return { action: "accept", content: { access: "session" } };
  });
  await client.connect(transport);
  for (let i = 0; i < 40; i++) {
    const apps = await call("list_apps", {});
    if (apps.text.includes(title)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("fixture window did not appear");
});

after(async () => {
  await client?.close();
  fixture?.kill();
});

test("lists the fixture window", { skip: !windows }, async () => {
  const apps = await call("list_apps", {});
  assert.match(apps.text, new RegExp(`"${title}"`));
});

test("asks for approval once, then reads the tree", { skip: !windows }, async () => {
  const state = await call("get_app_state", { app: title });
  assert.equal(state.isError, false, state.text);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Allow open-cu to control pwsh/);
  assert.match(state.text, /text field \((focused, )?settable, string\) Full name/);
  assert.match(state.text, /button Submit/);
  await call("get_app_state", { app: title });
  assert.equal(prompts.length, 1);
});

test("fills the form and reports only the changes", { skip: !windows }, async () => {
  const name = await call("set_value", { app: title, target: "full name", value: "Grace Hopper" });
  assert.match(name.text, /Set \d+ Full name to "Grace Hopper"/);
  assert.match(name.text, /~ \d+ text field .*Value: Grace Hopper/);

  const batch = await call("perform_actions", {
    app: title,
    actions: [
      { action: "set_value", target: "email address", value: "grace@example.com" },
      { action: "click", target: "subscribe to newsletter" },
      { action: "set_value", target: "plan", value: "Team" },
      { action: "click", target: "Green" },
      { action: "click", target: "Submit" },
    ],
  });
  assert.equal(batch.isError, false, batch.text);
  assert.match(batch.text, /Status: submitted Grace Hopper <grace@example.com> plan=Team colour=Green subscribed=True/);
});

test("element indices stay valid and unknown ones fail clearly", { skip: !windows }, async () => {
  const state = await call("get_app_state", { app: title });
  const save = state.text.match(/^(\d+) button Save draft/m);
  assert.ok(save, state.text);
  const click = await call("click", { app: title, element_index: save[1] });
  assert.match(click.text, /Status: draft saved/);
  const missing = await call("click", { app: title, element_index: 99999 });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /element_not_found/);
});

test("coordinates need a screenshot, then map onto the window", { skip: !windows }, async () => {
  const noShot = await call("click", { app: title, x: 10, y: 10 });
  assert.equal(noShot.isError, true);
  assert.match(noShot.text, /no_screenshot/);
  const state = await call("get_app_state", { app: title, include_screenshot: true });
  assert.equal(state.images, 1);
  assert.match(state.text, /Screenshot: \d+×\d+ px/);
});

test("vague targets do nothing and list candidates", { skip: !windows }, async () => {
  const vague = await call("click", { app: title, target: "button" });
  assert.equal(vague.isError, true);
  assert.match(vague.text, /target_ambiguous/);
  assert.match(vague.text, /Closest candidates/);
});

test("Jev resolves a paraphrased target", { skip: !windows || !withJev }, async () => {
  const found = await call("find_element", { app: title, description: "the button that keeps my progress without sending anything" });
  assert.match(found.text, /by Jev/);
  assert.match(found.text, /Best match: element \d+/);
  assert.match(found.text.split("\n")[1] ?? "", /Save draft/);
  const guarded = await call("click", { app: title, target: "the button on the far right" });
  assert.equal(guarded.isError, true);
  assert.match(guarded.text, /"delete"/);
});
