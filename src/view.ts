// Turns a window snapshot into the compact text an agent reads, and diffs two of them.
//
// One element per line, tab-indented by depth, in the grammar Codex Computer Use uses:
//   <index> <role> (<states>) <name>, Value: …, Description: …, Secondary Actions: …, ID: …
// Structural noise is removed first: unnamed wrapper panes are hoisted away, labels
// that repeat the control they name are dropped, and runs of plain text are merged.

import type { StateNode, WindowState } from "./state.ts";

export type ViewLine = { index: number; depth: number; text: string; node: StateNode };

export type View = {
  header: string;
  lines: ViewLine[];
  /** Index -> line text (no indentation), for diffing. */
  byIndex: Map<number, string>;
  focusedLine: string | undefined;
};

const ROLE_LABELS: Record<string, string> = {
  Button: "button",
  Calendar: "calendar",
  CheckBox: "checkbox",
  ComboBox: "combo box",
  Edit: "text field",
  Hyperlink: "link",
  Image: "image",
  ListItem: "list item",
  List: "list",
  Menu: "menu",
  MenuBar: "menu bar",
  MenuItem: "menu item",
  ProgressBar: "progress bar",
  RadioButton: "radio button",
  ScrollBar: "scroll bar",
  Slider: "slider",
  Spinner: "spinner",
  StatusBar: "status bar",
  Tab: "tab list",
  TabItem: "tab",
  Text: "text",
  ToolBar: "toolbar",
  ToolTip: "tooltip",
  Tree: "tree",
  TreeItem: "tree item",
  Custom: "custom",
  Group: "group",
  DataGrid: "grid",
  DataItem: "row",
  Document: "document",
  SplitButton: "split button",
  Window: "window",
  Pane: "pane",
  Header: "header",
  HeaderItem: "column header",
  Table: "table",
  AppBar: "app bar",
  SemanticZoom: "zoom view",
};

/** Subtrees that only add noise; the same capability is reachable another way. */
const DROPPED_ROLES = new Set(["Separator", "Thumb", "ScrollBar", "TitleBar"]);
const CONTAINER_ROLES = new Set(["Pane", "Group", "Custom", "Unknown"]);
const LABELLED_CONTROLS = new Set(["Edit", "ComboBox", "Spinner", "Slider", "List", "Document", "Tree", "DataGrid", "Table"]);
const INTERACTIVE_ACTIONS = new Set(["invoke", "toggle", "select", "expand", "collapse", "setValue", "defaultAction"]);

const MAX_FIELD = 200;
const MAX_MERGED_TEXT = 400;

export function clean(text: string | undefined, max = MAX_FIELD): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function roleLabel(node: StateNode): string {
  const localized = node.localizedRole?.trim().toLowerCase();
  if (localized && localized.length <= 24) {
    if (node.role === "Custom" || node.role === "Group") return localized;
    if (node.role === "Text" && localized.includes("heading")) return "heading";
  }
  if (node.role === "Window" && node.parentIndex !== null) return "dialog";
  return ROLE_LABELS[node.role] ?? node.role.toLowerCase();
}

function isInteractive(node: StateNode): boolean {
  return node.actions.some((action) => INTERACTIVE_ACTIONS.has(action)) || node.focusable;
}

function stateWords(node: StateNode): string[] {
  const words: string[] = [];
  if (node.focused) words.push("focused");
  if (node.selected) words.push("selected");
  if (!node.enabled) words.push("disabled");
  if (node.toggleState) words.push({ on: "checked", off: "unchecked", indeterminate: "mixed" }[node.toggleState]);
  if (node.expandState) words.push({ collapsed: "collapsed", expanded: "expanded", partial: "partially expanded" }[node.expandState]);
  if (node.actions.includes("setValue")) words.push(node.range ? "settable, float" : "settable, string");
  else if (node.readOnly && node.role === "Edit") words.push("read-only");
  if (node.offscreen) words.push("offscreen");
  return words;
}

export function secondaryActions(node: StateNode): string[] {
  const actions: string[] = [];
  if (node.expandState === "collapsed" || node.expandState === "partial") actions.push("Expand");
  if (node.expandState === "expanded") actions.push("Collapse");
  if (node.scroll?.vertical !== undefined) actions.push("Scroll Up", "Scroll Down");
  if (node.scroll?.horizontal !== undefined) actions.push("Scroll Left", "Scroll Right");
  return actions;
}

function meaningfulId(node: StateNode): string | undefined {
  const id = node.automationId?.trim();
  if (!id || id.length > 48 || id === node.name) return undefined;
  if (/^[\d\s:._-]*$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return undefined;
  return id;
}

export function renderLine(node: StateNode, nameOverride?: string): string {
  const name = nameOverride ?? clean(node.name);
  let head = `${node.index} ${roleLabel(node)}`;
  const states = stateWords(node);
  if (states.length) head += ` (${states.join(", ")})`;
  if (name) head += ` ${name}`;
  const extras: string[] = [];
  const value = clean(node.value);
  if (value && value !== name) extras.push(`Value: ${value}`);
  if (node.range && !value) extras.push(`Value: ${node.range.value} (${node.range.min}–${node.range.max})`);
  const help = clean(node.helpText);
  if (help && help !== name) extras.push(`Description: ${help}`);
  if (node.accelerator) extras.push(`Shortcut: ${node.accelerator}`);
  const secondary = secondaryActions(node);
  if (secondary.length) extras.push(`Secondary Actions: ${secondary.join(", ")}`);
  const id = meaningfulId(node);
  if (id) extras.push(`ID: ${id}`);
  return [head, ...extras].join(", ");
}

type Disposition = "keep" | "hoist" | "drop";

function dispose(node: StateNode, parent: StateNode | undefined, next: StateNode | undefined): Disposition {
  if (DROPPED_ROLES.has(node.role)) return "drop";
  const name = clean(node.name);
  if (node.role === "Text" && !name && !node.value) return "drop";
  if (node.role === "Image" && !name && !isInteractive(node)) return "drop";
  if (node.role === "Text" && name && parent && clean(parent.name) === name) return "drop";
  // A form label followed by the control it names: the control line carries the name.
  if (node.role === "Text" && name && next && LABELLED_CONTROLS.has(next.role) && clean(next.name) === name) return "drop";
  if (CONTAINER_ROLES.has(node.role) && !node.focused && !node.value && !isInteractive(node) && !node.scroll) {
    if (!name || (parent && clean(parent.name) === name)) return "hoist";
  }
  return "keep";
}

function isPlainText(node: StateNode): boolean {
  return node.role === "Text" && node.children.length === 0 && !isInteractive(node) && !node.focused && !!clean(node.name);
}

function walk(node: StateNode, depth: number, lines: ViewLine[]): void {
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const disposition = dispose(child, node, children[i + 1]);
    if (disposition === "drop") continue;
    if (disposition === "hoist") {
      walk(child, depth, lines);
      continue;
    }
    if (isPlainText(child)) {
      // Merge a run of plain text siblings into one line under the first index.
      let text = clean(child.name, MAX_MERGED_TEXT);
      while (i + 1 < children.length && isPlainText(children[i + 1]!) && text.length < MAX_MERGED_TEXT) {
        const sibling = children[i + 1]!;
        if (dispose(sibling, node, children[i + 2]) === "drop") break;
        text = clean(`${text} ${sibling.name}`, MAX_MERGED_TEXT);
        i++;
      }
      lines.push({ index: child.index, depth, text: renderLine(child, text), node: child });
      continue;
    }
    lines.push({ index: child.index, depth, text: renderLine(child), node: child });
    walk(child, depth + 1, lines);
  }
}

export function windowHeader(state: WindowState): string {
  const app = state.window.processName.replace(/\.exe$/i, "") || "unknown app";
  return `Window: "${clean(state.window.title, 120)}", App: ${app} (pid ${state.window.pid}, window ${state.hwnd}).`;
}

export function buildView(state: WindowState): View {
  const lines: ViewLine[] = [];
  if (state.root) walk(state.root, 0, lines);
  const byIndex = new Map(lines.map((line) => [line.index, line.text]));
  const focused = state.focused;
  const focusedLine = focused && focused !== state.root ? (byIndex.get(focused.index) ?? renderLine(focused)) : undefined;
  return { header: windowHeader(state), lines, byIndex, focusedLine };
}

export type RenderOptions = { maxLines: number; query?: string | undefined };

/** Words of a query, lower-cased; short and filler words are ignored. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._-]+/u)
    .filter((term) => term.length >= 2);
}

export function renderView(view: View, state: WindowState, options: RenderOptions): string {
  let lines = view.lines;
  let note = "";
  if (options.query?.trim()) {
    const terms = queryTerms(options.query);
    const keep = new Set<number>();
    lines.forEach((line, position) => {
      const haystack = line.text.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) return;
      keep.add(position);
      // Keep the enclosing lines so matches stay in context.
      let depth = line.depth;
      for (let back = position - 1; back >= 0 && depth > 0; back--) {
        if (lines[back]!.depth < depth) {
          keep.add(back);
          depth = lines[back]!.depth;
        }
      }
    });
    const matched = lines.length;
    lines = lines.filter((_, position) => keep.has(position));
    note = `Showing ${lines.length} of ${matched} lines that match "${options.query.trim()}".`;
  }
  let omitted = 0;
  if (lines.length > options.maxLines) {
    omitted = lines.length - options.maxLines;
    lines = lines.slice(0, options.maxLines);
  }
  const out = [view.header];
  if (note) out.push(note);
  out.push(...lines.map((line) => `${"\t".repeat(line.depth)}${line.text}`));
  if (omitted > 0) {
    out.push(`… ${omitted} more lines not shown. Narrow the view with get_app_state(query=…) or use find_element.`);
  }
  if (state.truncated) out.push("(The app's accessibility tree was larger than the snapshot limit; some elements are missing.)");
  if (!view.lines.length) out.push("(No accessibility elements. The app may draw its own UI; use a screenshot and coordinates.)");
  if (view.focusedLine) out.push(`The focused element is: ${view.focusedLine}`);
  return out.join("\n");
}

export type ViewDiff = { added: string[]; removed: string[]; changed: string[] };

/** A line without its focus marker; focus moves are reported once, separately. */
function unfocused(text: string): string {
  return text.replace(" (focused)", "").replace("(focused, ", "(");
}

export function diffViews(before: View, after: View): ViewDiff {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [index, text] of after.byIndex) {
    const previous = before.byIndex.get(index);
    if (previous === undefined) added.push(text);
    else if (unfocused(previous) !== unfocused(text)) changed.push(text);
  }
  const removed = [...before.byIndex].filter(([index]) => !after.byIndex.has(index)).map(([, text]) => text);
  return { added, removed, changed };
}

export function diffSize(diff: ViewDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

export function renderDiff(diff: ViewDiff): string {
  if (diffSize(diff) === 0) return "No changes in the accessibility tree.";
  return [
    "Changes (+ added, - removed, ~ changed):",
    ...diff.added.map((line) => `+ ${line}`),
    ...diff.removed.map((line) => `- ${line}`),
    ...diff.changed.map((line) => `~ ${line}`),
  ].join("\n");
}
