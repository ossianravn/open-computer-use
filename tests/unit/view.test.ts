import assert from "node:assert/strict";
import { test } from "node:test";
import { WindowState } from "../../src/state.ts";
import { buildView, diffViews, renderDiff, renderView } from "../../src/view.ts";
import { form, snapshot, windowInfo } from "./helpers.ts";

function stateOf(spec = form()) {
  const state = new WindowState(windowInfo());
  state.update(snapshot(spec));
  return state;
}

test("renders Codex-style lines and removes structural noise", () => {
  const state = stateOf();
  const text = renderView(buildView(state), state, { maxLines: 100 });
  const lines = text.split("\n");
  assert.equal(lines[0], 'Window: "Fixture", App: fixture (pid 42, window 100).');
  assert.ok(lines.includes("2 text field (settable, string) Full name, ID: fullName"));
  // The label that repeats the field's name is dropped.
  assert.ok(!lines.some((line) => /^1 text Full name/.test(line)));
  // The unnamed pane is hoisted: its buttons sit at the top level.
  assert.ok(lines.includes("4 button Save draft"));
  // Title bar controls are dropped.
  assert.ok(!text.includes("Close"));
});

test("indices are stable across snapshots and new elements get new numbers", () => {
  const state = new WindowState(windowInfo());
  state.update(snapshot(form()));
  const before = buildView(state);
  state.update(snapshot(form("Status: submitted", [{ role: "Button", name: "Retry", runtimeId: "42.50", actions: ["invoke"] }]), 2));
  const after = buildView(state);
  assert.equal(after.byIndex.get(4), before.byIndex.get(4));
  const diff = diffViews(before, after);
  assert.deepEqual(diff.changed, ["7 text Status: submitted"]);
  assert.deepEqual(diff.added, ["10 button Retry"]);
  assert.deepEqual(diff.removed, []);
  assert.match(renderDiff(diff), /\+ 10 button Retry/);
});

test("focus moves do not show up as changes", () => {
  const state = new WindowState(windowInfo());
  state.update(snapshot(form()));
  const before = buildView(state);
  const focusedSpec = form();
  focusedSpec.children![1]!.focused = true;
  state.update(snapshot(focusedSpec, 2));
  const after = buildView(state);
  assert.equal(diffViews(before, after).changed.length, 0);
  assert.match(after.focusedLine ?? "", /^2 text field \(focused/);
});

test("query keeps matching lines and their parents", () => {
  const spec = form();
  spec.children!.push({
    role: "List",
    name: "Colours",
    runtimeId: "42.60",
    children: [
      { role: "ListItem", name: "Red", runtimeId: "42.61", actions: ["select"] },
      { role: "ListItem", name: "Blue", runtimeId: "42.62", actions: ["select"] },
    ],
  });
  const state = stateOf(spec);
  const text = renderView(buildView(state), state, { maxLines: 100, query: "blue" });
  assert.match(text, /list Colours/);
  assert.match(text, /\t\d+ list item Blue/);
  assert.doesNotMatch(text, /Red/);
});

test("long views are cut with an explicit marker", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ role: "ListItem", name: `Item ${i}`, runtimeId: `9.${i}`, actions: ["select"] as never[] }));
  const state = stateOf({ role: "Window", name: "Big", runtimeId: "9", children: [{ role: "List", name: "Things", runtimeId: "9.x", children: items }] });
  const text = renderView(buildView(state), state, { maxLines: 10 });
  assert.match(text, /… 21 more lines not shown/);
});
