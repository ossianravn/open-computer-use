// Finding the element an agent describes in words ("the Save button", "email field").
//
// Candidates come from the rendered view. A lexical scorer ranks them without any
// model; when Jev is enabled it makes the final pick (see jev.ts). Either way the
// resolver only acts on a clear winner and otherwise returns the shortlist.

import type { StateNode, WindowState } from "./state.ts";
import { clean, queryTerms, renderLine, roleLabel, type View } from "./view.ts";

export type Purpose = "click" | "set_value" | "scroll" | "type" | "secondary" | "find";

export type Candidate = {
  node: StateNode;
  /** The element as the agent sees it, without the index. */
  description: string;
  /** Named ancestors, nearest first: "list Favourite colour › window OCU Fixture". */
  context: string;
  /** Rough position in the window, in words. */
  position: string;
  lexical: number;
};

const ROLE_WORDS: Record<string, string[]> = {
  button: ["Button", "SplitButton"],
  field: ["Edit", "ComboBox", "Document"],
  box: ["Edit", "ComboBox", "CheckBox", "List"],
  input: ["Edit", "ComboBox"],
  textbox: ["Edit"],
  checkbox: ["CheckBox"],
  check: ["CheckBox"],
  toggle: ["CheckBox", "Button"],
  radio: ["RadioButton"],
  link: ["Hyperlink"],
  tab: ["TabItem"],
  menu: ["MenuItem", "Menu", "MenuBar"],
  item: ["ListItem", "TreeItem", "MenuItem", "DataItem"],
  option: ["ListItem", "RadioButton"],
  dropdown: ["ComboBox"],
  combo: ["ComboBox"],
  list: ["List", "ListItem"],
  slider: ["Slider"],
  row: ["DataItem", "ListItem"],
  heading: ["Text"],
  image: ["Image"],
  icon: ["Image", "Button"],
};

const FILLER = new Set(["the", "a", "an", "on", "in", "of", "to", "for", "and", "or", "click", "press", "tap", "select", "that", "this", "with"]);

const CLICKABLE_ROLES = new Set([
  "Button", "SplitButton", "Hyperlink", "MenuItem", "ListItem", "TabItem", "TreeItem", "CheckBox",
  "RadioButton", "ComboBox", "Edit", "DataItem", "HeaderItem", "Image", "Document",
]);

function wantsNode(node: StateNode, purpose: Purpose): boolean {
  const has = (action: string) => node.actions.includes(action as never);
  switch (purpose) {
    case "set_value":
      return has("setValue") || (node.role === "ComboBox" || (node.role === "Edit" && node.focusable));
    case "scroll":
      return has("scroll") || node.role === "List" || node.role === "Document" || node.role === "Tree";
    case "type":
      return node.role === "Edit" || node.role === "Document" || node.role === "ComboBox" || node.focusable;
    case "click":
    case "secondary":
      return (
        has("invoke") || has("toggle") || has("select") || has("expand") || has("collapse") || has("defaultAction") ||
        node.focusable || CLICKABLE_ROLES.has(node.role) || (node.role === "Text" && !!clean(node.name))
      );
    case "find":
      return true;
  }
}

function position(node: StateNode, state: WindowState): string {
  const frame = state.window.rect;
  const { x, y, width, height } = node.rect;
  if (width <= 0 || height <= 0 || frame.width <= 0 || frame.height <= 0) return "";
  const fx = (x + width / 2 - frame.x) / frame.width;
  const fy = (y + height / 2 - frame.y) / frame.height;
  const vertical = fy < 0.33 ? "top" : fy < 0.66 ? "middle" : "bottom";
  const horizontal = fx < 0.33 ? "left" : fx < 0.66 ? "center" : "right";
  return vertical === "middle" && horizontal === "center" ? "center" : `${vertical} ${horizontal}`;
}

function context(node: StateNode, state: WindowState): string {
  const title = clean(state.window.title);
  return state
    .ancestors(node)
    // The window's own name (and browser panes repeating it) says nothing new.
    .filter((ancestor) => clean(ancestor.name) && !title.startsWith(clean(ancestor.name)))
    .slice(0, 3)
    .map((ancestor) => `${roleLabel(ancestor)} ${clean(ancestor.name, 60)}`)
    .join(" › ");
}

function lexicalScore(target: string, candidate: Omit<Candidate, "lexical">): number {
  const terms = queryTerms(target).filter((term) => !FILLER.has(term));
  const node = candidate.node;
  const name = clean(node.name).toLowerCase();
  const wanted = target.trim().toLowerCase();
  let score = 0;
  if (name && name === wanted) score += 8;
  for (const term of terms) {
    const roles = ROLE_WORDS[term];
    if (roles) {
      if (roles.includes(node.role)) score += 1.5;
      continue;
    }
    if (name === term) score += 4;
    else if (new RegExp(`(^|\\W)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name)) score += 3;
    else if (name.includes(term)) score += 1.5;
    if (clean(node.value).toLowerCase().includes(term)) score += 1;
    if ((node.automationId ?? "").toLowerCase().includes(term)) score += 1.5;
    if ((node.helpText ?? "").toLowerCase().includes(term)) score += 0.75;
    if (candidate.context.toLowerCase().includes(term)) score += 0.5;
  }
  if (score > 0 && !node.enabled) score *= 0.6;
  if (score > 0 && node.offscreen) score *= 0.8;
  return score;
}

export function candidatesFor(state: WindowState, view: View, target: string, purpose: Purpose): Candidate[] {
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  const add = (node: StateNode, text: string) => {
    if (seen.has(node.index) || !wantsNode(node, purpose)) return;
    seen.add(node.index);
    const base = { node, description: text.slice(text.indexOf(" ") + 1), context: context(node, state), position: position(node, state) };
    candidates.push({ ...base, lexical: lexicalScore(target, base) });
  };
  for (const line of view.lines) {
    add(line.node, line.text);
    // Links written inline in a text line are targets of their own.
    for (const link of line.inline ?? []) add(link, renderLine(link));
  }
  return candidates;
}

export function rankLexically(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => b.lexical - a.lexical);
}

/** A clear lexical winner: a strong match well ahead of the runner-up. */
export function lexicalPick(ranked: Candidate[]): Candidate | undefined {
  const [best, second] = ranked;
  if (!best || best.lexical < 4) return undefined;
  if (second && second.lexical > 0 && best.lexical < second.lexical * 1.6) return undefined;
  return best;
}

const DESTRUCTIVE = /\b(delete|remove|erase|discard|clear|reset|uninstall|format|send|submit|post|publish|pay|purchase|buy|order|checkout|confirm|transfer|sign out|log ?out|close account|unsubscribe)\b/i;

/**
 * An element whose name carries a destructive verb the target does not mention. The
 * resolver never acts on such a pick by itself; the agent has to name it explicitly.
 */
export function destructiveMismatch(target: string, node: StateNode): string | undefined {
  const verb = clean(node.name).match(DESTRUCTIVE)?.[0];
  if (!verb) return undefined;
  return new RegExp(`\\b${verb}`, "i").test(target) ? undefined : verb.toLowerCase();
}

export function describeCandidate(candidate: Candidate): string {
  const extra = [candidate.context && `in ${candidate.context}`, candidate.position].filter(Boolean).join(", ");
  return `${renderLine(candidate.node)}${extra ? `  [${extra}]` : ""}`;
}
