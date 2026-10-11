import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTarget } from "../../src/jev.ts";
import { WindowState } from "../../src/state.ts";
import { buildView } from "../../src/view.ts";
import { form, snapshot, windowInfo } from "./helpers.ts";

function setup() {
  const state = new WindowState(windowInfo());
  state.update(snapshot(form()));
  return { state, view: buildView(state) };
}

test("an exact name (role word allowed) is picked without any model", async () => {
  const { state, view } = setup();
  const resolution = await resolveTarget(state, view, "Submit button", "click", undefined);
  assert.equal(resolution.decision, "pick");
  assert.equal(resolution.method, "exact");
  assert.equal(resolution.candidate?.node.name, "Submit");
});

test("a clear word match is picked lexically", async () => {
  const { state, view } = setup();
  const resolution = await resolveTarget(state, view, "draft save", "click", undefined);
  assert.equal(resolution.decision, "pick");
  assert.equal(resolution.method, "lexical");
  assert.equal(resolution.candidate?.node.name, "Save draft");
});

test("a vague description returns candidates instead of acting", async () => {
  const { state, view } = setup();
  const resolution = await resolveTarget(state, view, "button", "click", undefined);
  assert.equal(resolution.decision, "ambiguous");
  assert.ok(resolution.ranked.length >= 3);
});

test("set_value only considers settable elements", async () => {
  const { state, view } = setup();
  const resolution = await resolveTarget(state, view, "full name", "set_value", undefined);
  assert.equal(resolution.decision, "pick");
  assert.equal(resolution.candidate?.node.role, "Edit");
});

test("destructive picks need the agent to say the verb", async () => {
  const { state, view } = setup();
  const named = await resolveTarget(state, view, "delete all data", "click", undefined);
  assert.equal(named.decision, "pick");
  const vague = await resolveTarget(state, view, "all data", "click", undefined);
  assert.equal(vague.decision, "ambiguous");
  assert.match(vague.reason ?? "", /"delete"/);
});

test("nothing matching is reported as absent", async () => {
  const { state, view } = setup();
  const resolution = await resolveTarget(state, view, "zebra crossing", "click", undefined);
  assert.equal(resolution.decision, "absent");
});
