// The tool implementations, independent of MCP. The server (server.ts) and the CLI
// (cli.ts) are thin wrappers around this class.

import { type Resolved, aliasExe, displayName, parseWindowId, resolveWindow } from "./apps.ts";
import { readFileSync, statSync } from "node:fs";
import { type Config, LAST_CLIENT_FILE } from "./config.ts";
import { ToolError, errorMessage } from "./errors.ts";
import { type Jev, type Resolution, resolveTarget, verifyOutcome } from "./jev.ts";
import type { Platform } from "./platform.ts";
import { Approvals, type AskUser, LAUNCH_DENIED, appIdentity, assertKeyAllowed, assertNotBlocked, blockReason } from "./policy.ts";
import type { ElementActionResult, HelperMethods, WindowInfo } from "./protocol.ts";
import { IdentityMap, type StateNode, WindowState } from "./state.ts";
import { type Purpose, describeCandidate } from "./targets.ts";
import { type View, buildView, clean, diffSize, diffViews, renderDiff, renderLine, renderView } from "./view.ts";

export type ToolOutput = { text: string; images?: { data: string; mimeType: string }[]; isError?: boolean };

export type ReturnState = "diff" | "full" | "none";
export type Direction = "up" | "down" | "left" | "right";
export type MouseButton = "left" | "right" | "middle";

type AppArgs = { app?: string | undefined; window?: string | number | undefined };
type ElementArgs = AppArgs & { element_index?: string | number | undefined; target?: string | undefined };
type OutcomeArgs = { return_state?: ReturnState | undefined; expect?: string | undefined };

export type ClickArgs = ElementArgs &
  OutcomeArgs & {
    x?: number | undefined;
    y?: number | undefined;
    click_count?: number | undefined;
    mouse_button?: MouseButton | undefined;
    modifiers?: string[] | undefined;
    click_method?: "auto" | "accessibility" | "physical" | undefined;
  };
export type SetValueArgs = ElementArgs & OutcomeArgs & { value: string };
export type TypeTextArgs = ElementArgs & OutcomeArgs & { text: string };
export type PressKeyArgs = AppArgs & OutcomeArgs & { key: string; repeat?: number | undefined };
export type ScrollArgs = ElementArgs &
  OutcomeArgs & { direction: Direction; pages?: number | undefined; x?: number | undefined; y?: number | undefined };
export type DragArgs = AppArgs & OutcomeArgs & { from_x: number; from_y: number; to_x: number; to_y: number };
export type SecondaryArgs = ElementArgs & OutcomeArgs & { action: string };
export type StateArgs = AppArgs & {
  include_screenshot?: boolean | undefined;
  query?: string | undefined;
  include_offscreen?: boolean | undefined;
};
export type FindArgs = AppArgs & { description: string; purpose?: Purpose | undefined; limit?: number | undefined };

export type Step = {
  action: "click" | "set_value" | "type_text" | "press_key" | "scroll" | "perform_secondary_action" | "drag" | "wait";
  element_index?: string | number | undefined;
  target?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  value?: string | undefined;
  text?: string | undefined;
  key?: string | undefined;
  direction?: Direction | undefined;
  pages?: number | undefined;
  name?: string | undefined;
  mouse_button?: MouseButton | undefined;
  click_count?: number | undefined;
  to_x?: number | undefined;
  to_y?: number | undefined;
  ms?: number | undefined;
};
export type BatchArgs = AppArgs & OutcomeArgs & { actions: Step[]; stop_on_error?: boolean | undefined };

type ElementParams = HelperMethods["elementAction"]["params"];
type ElementActionName = ElementParams["action"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Roles where a click means "choose this", not "activate this". */
const SELECT_ROLES = new Set(["ListItem", "TreeItem", "TabItem", "RadioButton", "DataItem"]);
const TEXT_ROLES = new Set(["Edit", "Document"]);

export type ComputerOptions = {
  config: Config;
  platform: Platform;
  jev?: Jev | undefined;
  askUser?: AskUser | undefined;
  /** Persisted element identities, so indices survive across CLI invocations. */
  identities?: Map<number, IdentityMap> | undefined;
};

export class Computer {
  readonly config: Config;
  readonly platform: Platform;
  readonly jev: Jev | undefined;
  readonly approvals: Approvals;
  private readonly states = new Map<number, WindowState>();
  private readonly views = new Map<number, View>();
  private readonly identities: Map<number, IdentityMap>;
  private screenshotCounter = 0;
  /** The window a perform_actions call is working in, while it runs. */
  private batch: WindowState | undefined;

  constructor(options: ComputerOptions) {
    this.config = options.config;
    this.platform = options.platform;
    this.jev = options.jev;
    this.approvals = new Approvals(options.config, options.askUser);
    this.identities = options.identities ?? new Map();
  }

  private get helper() {
    return this.platform.helper;
  }

  get identityMaps(): Map<number, IdentityMap> {
    return this.identities;
  }

  // ---------------------------------------------------------------- windows

  private async windows(): Promise<{ all: WindowInfo[]; apps: WindowInfo[] }> {
    const all = await this.helper.call("listWindows", { includeAll: true });
    return { all, apps: all.filter((window) => window.appWindow) };
  }

  /** Resolve, police and approve the target window; snapshot it if it is new. */
  private async open(args: AppArgs): Promise<{ state: WindowState; resolved: Resolved; all: WindowInfo[] }> {
    const { all, apps } = await this.windows();
    const resolved = resolveWindow(all, apps, args.app, parseWindowId(args.window));
    assertNotBlocked(resolved.window, this.config);
    await this.approvals.ensure(resolved.window);
    let state = this.states.get(resolved.window.hwnd);
    if (!state) {
      let identities = this.identities.get(resolved.window.hwnd);
      if (!identities) {
        identities = new IdentityMap();
        this.identities.set(resolved.window.hwnd, identities);
      }
      state = new WindowState(resolved.window, identities);
      this.states.set(resolved.window.hwnd, state);
    }
    state.window = resolved.window;
    this.touch(state);
    if (!state.root) await this.refresh(state);
    return { state, resolved, all };
  }

  /** Keep the "agent is using your computer" overlay up on this window's screen. */
  private touch(state: WindowState): void {
    if (!this.config.overlay) return;
    this.helper
      .call("overlayShow", { hwnd: state.hwnd, label: displayName(state.window), idleMs: this.config.overlayIdleMs })
      .catch(() => undefined);
  }

  private async refresh(state: WindowState, includeOffscreen = false): Promise<View> {
    let snapshot = await this.helper.call("snapshot", { hwnd: state.hwnd, includeOffscreen });
    // Chromium (Chrome, Edge, Electron apps) builds its page tree only once an
    // accessibility client asks; the first read shows browser chrome alone.
    if (state.snapshotId === 0 && snapshot.window.className.startsWith("Chrome_WidgetWin")) {
      const hasPage = (nodes: typeof snapshot.nodes) =>
        nodes.some((node) => node.role === "Document" && nodes.some((child) => child.parent === node.id));
      for (let attempt = 0; attempt < 8 && !hasPage(snapshot.nodes); attempt++) {
        await sleep(250);
        snapshot = await this.helper.call("snapshot", { hwnd: state.hwnd, includeOffscreen });
      }
    }
    state.update(snapshot);
    const view = buildView(state);
    this.views.set(state.hwnd, view);
    return view;
  }

  private view(state: WindowState): View {
    return this.views.get(state.hwnd) ?? buildView(state);
  }

  // ---------------------------------------------------------------- elements

  private node(state: WindowState, index: string | number): StateNode {
    const parsed = typeof index === "number" ? index : Number.parseInt(String(index).trim(), 10);
    if (!Number.isInteger(parsed)) throw new ToolError("bad_params", `element_index must be a number, not "${index}".`);
    const node = state.byIndex.get(parsed);
    if (!node) {
      throw new ToolError(
        "element_not_found",
        `Element ${parsed} is not in the current state of this window (it may have closed). Call get_app_state and use a current index.`,
      );
    }
    return node;
  }

  private async elementCall(
    state: WindowState,
    node: StateNode,
    action: ElementActionName,
    extra: Omit<ElementParams, "hwnd" | "elementId" | "action"> = {},
  ): Promise<ElementActionResult> {
    const attempt = () =>
      this.helper.call("elementAction", {
        hwnd: state.hwnd,
        elementId: state.helperIds.get(node.index)!,
        snapshotId: state.snapshotId,
        action,
        ...extra,
      });
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ToolError) || !["element_unavailable", "stale_snapshot", "no_snapshot"].includes(error.code)) throw error;
      // The element moved under us (or the helper restarted). Same identity, fresh handle.
      await this.refresh(state);
      if (!state.byIndex.has(node.index)) {
        throw new ToolError("element_gone", `Element ${node.index} no longer exists. The new state is available via get_app_state.`);
      }
      return attempt();
    }
  }

  private async resolve(state: WindowState, target: string, purpose: Purpose): Promise<Resolution> {
    // Resolve against fresh state: the agent describes what is on screen now.
    if (Date.now() - state.takenAt > 1500) await this.refresh(state);
    return resolveTarget(state, this.view(state), target, purpose, this.jev);
  }

  private resolutionNote(target: string, resolution: Resolution): string {
    const picked = resolution.candidate!;
    const how =
      resolution.method === "jev"
        ? `Jev, confidence ${resolution.confidence?.toFixed(2)}, presence ${resolution.presence?.toFixed(2)}, ${resolution.ms} ms`
        : `${resolution.method === "exact" ? "exact name" : "lexical"} match, ${resolution.ms} ms`;
    return `Target "${target}" → ${renderLine(picked.node)} (${how}).${resolution.reason ? ` ${resolution.reason}` : ""}`;
  }

  private ambiguity(target: string, resolution: Resolution, limit = 6): ToolError {
    const shown = resolution.ranked.filter((entry, position) => position < 2 || entry.probability === undefined || entry.probability >= 0.02);
    const lines = shown.slice(0, limit).map(({ candidate, probability }) =>
      `  ${describeCandidate(candidate)}${probability !== undefined ? `  (p=${probability.toFixed(2)})` : ""}`,
    );
    const head =
      resolution.decision === "absent"
        ? `No element matches "${target}".`
        : `Could not pick a single element for "${target}".`;
    const body = lines.length ? `\nClosest candidates:\n${lines.join("\n")}` : "";
    return new ToolError(
      resolution.decision === "absent" ? "target_not_found" : "target_ambiguous",
      `${head}${resolution.reason ? ` ${resolution.reason}` : ""}${body}\nNothing was done. Retry with element_index, or a more specific target.`,
    );
  }

  private async pick(state: WindowState, args: ElementArgs, purpose: Purpose): Promise<{ node: StateNode; note?: string }> {
    if (args.element_index !== undefined && args.element_index !== "") return { node: this.node(state, args.element_index) };
    if (args.target?.trim()) {
      const resolution = await this.resolve(state, args.target.trim(), purpose);
      if (resolution.decision !== "pick" || !resolution.candidate) throw this.ambiguity(args.target, resolution);
      return { node: resolution.candidate.node, note: this.resolutionNote(args.target.trim(), resolution) };
    }
    throw new ToolError("bad_params", "Pass element_index (from get_app_state) or target (a short description of the element).");
  }

  /** Screen point for screenshot coordinates, corrected for window moves. */
  private async toScreen(state: WindowState, x: number, y: number): Promise<{ x: number; y: number }> {
    const shot = state.screenshot;
    if (!shot) {
      throw new ToolError(
        "no_screenshot",
        "Coordinates refer to a screenshot of this window. Call get_app_state with include_screenshot=true first, or use element_index.",
      );
    }
    if (x < 0 || y < 0 || x > shot.width || y > shot.height) {
      throw new ToolError("bad_coordinates", `(${x}, ${y}) is outside the ${shot.width}×${shot.height} screenshot.`);
    }
    const current = (await this.helper.call("listWindows", { includeAll: true })).find((w) => w.hwnd === state.hwnd);
    if (!current) throw new ToolError("window_gone", "The window has closed.");
    if (Math.abs(current.rect.width - shot.frame.width) > 4 || Math.abs(current.rect.height - shot.frame.height) > 4) {
      throw new ToolError("screenshot_stale", "The window was resized since the screenshot. Take a new screenshot first.");
    }
    return { x: Math.round(current.rect.x + x * shot.scale), y: Math.round(current.rect.y + y * shot.scale) };
  }

  private async centerOf(state: WindowState, node: StateNode): Promise<{ x: number; y: number }> {
    let info = await this.helper.call("elementInfo", {
      hwnd: state.hwnd,
      elementId: state.helperIds.get(node.index)!,
      snapshotId: state.snapshotId,
    });
    if (info.node.offscreen && node.actions.includes("scrollIntoView")) {
      await this.elementCall(state, node, "scrollIntoView");
      await sleep(100);
      info = await this.helper.call("elementInfo", { hwnd: state.hwnd, elementId: state.helperIds.get(node.index)! });
    }
    if (info.clickablePoint) return info.clickablePoint;
    const { x, y, width, height } = info.node.rect;
    if (width <= 0 || height <= 0) {
      throw new ToolError("no_position", `Element ${node.index} has no on-screen position. Scroll it into view first.`);
    }
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  }

  // ---------------------------------------------------------------- outcomes

  /** Wait for the UI, re-read it and describe what changed. */
  private async outcome(
    state: WindowState,
    before: View,
    beforeWindows: WindowInfo[],
    summary: string[],
    args: OutcomeArgs,
    pending = false,
  ): Promise<ToolOutput> {
    const mode = args.return_state ?? "diff";
    if (this.batch) {
      // Between batch steps: just let the UI catch up and re-read it for the next step.
      await sleep(Math.min(this.config.settleMs, 120) + (pending ? 300 : 0));
      await this.refresh(state);
      return { text: summary.join(" ") };
    }
    await sleep(this.config.settleMs + (pending ? 400 : 0));
    const lines = [...summary];
    const { all } = await this.windows();
    if (!all.some((w) => w.hwnd === state.hwnd)) {
      this.states.delete(state.hwnd);
      lines.push("The window closed.");
      const remaining = all.filter((w) => w.pid === state.window.pid && w.title);
      if (remaining.length) lines.push(`Other windows of this app: ${remaining.map((w) => `${w.hwnd} "${clean(w.title, 60)}"`).join(", ")}.`);
      return { text: lines.join("\n") };
    }
    const known = new Set(beforeWindows.map((w) => w.hwnd));
    const opened = all.filter((w) => !known.has(w.hwnd) && w.pid === state.window.pid && w.title);
    const windowNotes = opened.map((w) => `New window: ${w.hwnd} "${clean(w.title, 80)}"${w.owner ? " (dialog)" : ""}. Pass window=${w.hwnd} to work in it.`);

    const after = await this.refresh(state);
    const diff = diffViews(before, after);
    if (mode === "full" || (mode === "diff" && diffSize(diff) > Math.max(60, after.lines.length * 0.6))) {
      lines.push(renderView(after, state, { maxLines: this.config.maxStateLines }));
    } else if (mode === "diff") {
      lines.push(renderDiff(diff));
      if (after.focusedLine && after.focusedLine !== before.focusedLine) lines.push(`The focused element is: ${after.focusedLine}`);
    }
    lines.push(...windowNotes);
    if (args.expect?.trim()) lines.push(await this.check(state, summary.join(" "), args.expect.trim(), diff, after, windowNotes));
    return { text: lines.join("\n") };
  }

  private async check(state: WindowState, action: string, expected: string, diff: ReturnType<typeof diffViews>, after: View, windows: string[]): Promise<string> {
    if (!this.jev?.get()) return `Expectation "${expected}" not checked: ${this.jev?.status().reason ?? "Jev is off"}. Read the changes above.`;
    try {
      const verdict = await verifyOutcome(this.jev, state, action, expected, diff, after.focusedLine, windows);
      const p = verdict.probability;
      const label = p >= 0.75 ? "likely met" : p <= 0.25 ? "likely NOT met" : "unclear";
      return `Expectation "${expected}": ${label} (Jev p=${p.toFixed(2)}, ${verdict.ms} ms).`;
    } catch (error) {
      return `Expectation "${expected}" not checked: Jev failed (${errorMessage(error).split("\n")[0]}).`;
    }
  }

  private async begin(args: AppArgs): Promise<{ state: WindowState; before: View; beforeWindows: WindowInfo[]; note?: string }> {
    // Inside perform_actions the window is already resolved, approved and fresh.
    if (this.batch) {
      this.touch(this.batch);
      return { state: this.batch, before: this.view(this.batch), beforeWindows: [] };
    }
    const { state, resolved, all } = await this.open(args);
    // Act on what is there now: re-read when the last observation is not fresh.
    if (Date.now() - state.takenAt > 1500) await this.refresh(state);
    return { state, before: this.view(state), beforeWindows: all, ...(resolved.note ? { note: resolved.note } : {}) };
  }

  // ---------------------------------------------------------------- tools

  async listApps(args: { include_installed?: boolean | undefined } = {}): Promise<ToolOutput> {
    const { all, apps } = await this.windows();
    const groups = new Map<number, WindowInfo[]>();
    for (const window of apps) groups.set(window.pid, [...(groups.get(window.pid) ?? []), window]);
    const lines = ["Running apps (pass the name as `app`, or a window id as `window`):"];
    for (const windows of groups.values()) {
      const first = windows[0]!;
      const identity = appIdentity(first);
      const tags: string[] = [];
      const block = blockReason(first, this.config);
      if (block) tags.push("blocked");
      else if (this.approvals.isApproved(identity)) tags.push("approved");
      if (block) {
        // Window titles of blocked apps (password vaults, terminals) stay private.
        lines.push(`- ${displayName(first)} — ${identity.exe} [blocked]`);
        continue;
      }
      const dialogs = all.filter((w) => w.pid === first.pid && w.owner && windows.some((main) => main.hwnd === w.owner) && w.title);
      const listed = [...windows, ...dialogs]
        .map((w) => `${w.hwnd} "${clean(w.title, 70)}"${w.owner ? " (dialog)" : ""}${w.minimized ? " (minimized)" : ""}${w.foreground ? " (foreground)" : ""}`)
        .join("; ");
      lines.push(`- ${displayName(first)} — ${identity.exe}${tags.length ? ` [${tags.join(", ")}]` : ""} — windows: ${listed}`);
    }
    if (args.include_installed) {
      const installed = await this.platform.installedApps();
      lines.push("", `Installed apps (${installed.length}; start one with launch_app):`);
      lines.push(...installed.map((app) => `- ${app.name}`));
    }
    return { text: lines.join("\n") };
  }

  async launchApp(args: { app: string }): Promise<ToolOutput> {
    const name = args.app.trim();
    if (!name) throw new ToolError("bad_params", "Pass the app name to launch.");
    if (/[\\/:]/.test(name)) throw new ToolError("bad_params", "Launch apps by name (as listed by list_apps with include_installed), not by path.");
    const installed = await this.platform.installedApps();
    const lower = name.toLowerCase();
    const matches = installed.filter((app) => app.name.toLowerCase() === lower || app.id.toLowerCase() === lower);
    // Start-menu names are localized ("Lommeregner"); package ids are not ("Microsoft.WindowsCalculator…").
    const compact = lower.replace(/\s+/g, "");
    const byId = (app: { id: string }) => (app.id.split("!")[0] ?? "").toLowerCase().split(/[._]/).some((part) => part === compact || part === `windows${compact}`);
    const loose = matches.length
      ? matches
      : installed.filter((app) => app.name.toLowerCase().includes(lower)).concat(installed.filter((app) => !app.name.toLowerCase().includes(lower) && byId(app)));
    const program = aliasExe(name) ?? (/\.exe$/i.test(name) ? name : `${name}.exe`);
    const fake: WindowInfo = {
      hwnd: 0, title: name, className: "", pid: 0, processName: program, exePath: null,
      rect: { x: 0, y: 0, width: 0, height: 0 }, minimized: false, maximized: false, foreground: false, enabled: true, owner: null, appWindow: true, dpi: 96,
    };
    assertNotBlocked(fake, this.config);
    if (LAUNCH_DENIED.includes(program.toLowerCase())) {
      throw new ToolError("app_blocked", `launch_app does not start shells or script hosts (${program}). Use your own shell tool.`);
    }
    const before = new Set((await this.helper.call("listWindows", { includeAll: true })).map((w) => w.hwnd));
    if (loose.length === 1 || matches.length) await this.platform.launch(loose[0]!);
    else if (loose.length > 1) {
      throw new ToolError("app_ambiguous", `Several installed apps match "${name}": ${loose.slice(0, 8).map((app) => app.name).join(", ")}. Use the exact name.`);
    } else await this.platform.launch({ program: name });

    for (let waited = 0; waited < 15_000; waited += 250) {
      await sleep(250);
      const fresh = (await this.helper.call("listWindows", {})).filter((w) => !before.has(w.hwnd));
      const window = fresh.find((w) => blockReason(w, this.config) === undefined) ?? fresh[0];
      if (window) {
        assertNotBlocked(window, this.config);
        return {
          text: `Started ${loose[0]?.name ?? name}: window ${window.hwnd} "${clean(window.title, 80)}" (${window.processName}). Call get_app_state with window=${window.hwnd} to read it.`,
        };
      }
    }
    return { text: `Asked Windows to start ${loose[0]?.name ?? name}, but no new window appeared within 15 s. It may already be running; call list_apps.` };
  }

  async getAppState(args: StateArgs): Promise<ToolOutput> {
    const { state, resolved } = await this.open(args);
    if (state.window.minimized) {
      await this.helper.call("activateWindow", { hwnd: state.hwnd });
      await sleep(250);
    }
    const view = await this.refresh(state, args.include_offscreen ?? false);
    const lines: string[] = [];
    if (resolved.note) lines.push(resolved.note);
    lines.push(renderView(view, state, { maxLines: this.config.maxStateLines, query: args.query }));
    const others = resolved.others.filter((w) => w.hwnd !== state.hwnd);
    if (others.length) lines.push(`Other windows of this app: ${others.map((w) => `${w.hwnd} "${clean(w.title, 60)}"${w.owner ? " (dialog)" : ""}`).join(", ")}.`);

    const named = view.lines.filter((line) => clean(line.node.name)).length;
    const wantShot =
      args.include_screenshot ?? (this.config.screenshots === "always" ? true : this.config.screenshots === "never" ? false : named < 8);
    const images: ToolOutput["images"] = [];
    if (wantShot) {
      try {
        const shot = await this.helper.call("screenshot", { hwnd: state.hwnd, maxEdge: this.config.screenshotMaxEdge });
        state.screenshot = { id: ++this.screenshotCounter, scale: shot.scale, width: shot.width, height: shot.height, frame: shot.origin };
        images.push({ data: shot.data, mimeType: shot.mimeType });
        lines.push(`Screenshot: ${shot.width}×${shot.height} px. Coordinates for click/scroll/drag are pixels in this image.`);
      } catch (error) {
        lines.push(`Screenshot unavailable: ${errorMessage(error)}`);
      }
    }
    if (this.jev?.settings.enabled) {
      const status = this.jev.status();
      if (!status.ready) lines.push(`Jev targeting unavailable: ${status.reason}`);
    }
    return { text: lines.join("\n"), images };
  }

  async findElement(args: FindArgs): Promise<ToolOutput> {
    const { state } = await this.open(args);
    const resolution = await this.resolve(state, args.description, args.purpose ?? "find");
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
    const how =
      resolution.method === "jev"
        ? `Jev (${resolution.ms} ms, presence ${resolution.presence?.toFixed(2)}${resolution.agree === false ? ", orders disagreed" : ""})`
        : `${resolution.method === "exact" ? "exact name" : "lexical"} match (${resolution.ms} ms)`;
    const lines = [`Matches for "${args.description}" by ${how}:`];
    // Jev spreads almost all probability over real matches; drop the near-zero tail.
    const shown = resolution.ranked.filter((entry, position) => position === 0 || entry.probability === undefined || entry.probability >= 0.02);
    if (!shown.length) lines.push("  none");
    for (const { candidate, probability } of shown.slice(0, limit)) {
      lines.push(`  ${describeCandidate(candidate)}${probability !== undefined ? `  (p=${probability.toFixed(2)})` : ""}`);
    }
    if (resolution.decision === "pick" && resolution.candidate) lines.push(`Best match: element ${resolution.candidate.node.index}.`);
    else if (resolution.reason) lines.push(resolution.reason);
    return { text: lines.join("\n") };
  }

  /** Click an element the cheapest reliable way; returns how it was delivered. */
  private async clickNode(state: WindowState, node: StateNode, args: ClickArgs): Promise<{ how: string; pending: boolean }> {
    const button = args.mouse_button ?? "left";
    const count = args.click_count ?? 1;
    const plain = button === "left" && count === 1 && !args.modifiers?.length;
    const method = args.click_method ?? "auto";
    if (method !== "physical" && plain) {
      const has = (action: string) => node.actions.includes(action as never);
      let action: "invoke" | "toggle" | "select" | "expand" | "collapse" | "defaultAction" | "focus" | undefined;
      if (has("select") && SELECT_ROLES.has(node.role)) action = "select";
      else if (has("toggle")) action = "toggle";
      else if (has("invoke") && node.role !== "ComboBox") action = "invoke";
      else if (has("expand")) action = "expand";
      else if (has("collapse")) action = "collapse";
      else if (has("select")) action = "select";
      else if (has("defaultAction")) action = "defaultAction";
      else if (TEXT_ROLES.has(node.role) && node.focusable) action = "focus";
      if (action) {
        const result = await this.elementCall(state, node, action);
        return {
          how: `via UI Automation (${action})${result.pending ? "; the app is still handling it (it may have opened a modal dialog)" : ""}`,
          pending: !!result.pending,
        };
      }
      if (method === "accessibility") {
        throw new ToolError("unsupported", `Element ${node.index} has no accessibility action for a click. Use click_method "physical".`);
      }
    }
    if (method === "accessibility") throw new ToolError("unsupported", "Accessibility clicks are left single clicks without modifiers.");
    const point = await this.centerOf(state, node);
    await this.helper.call("click", { ...point, hwnd: state.hwnd, button, count, modifiers: args.modifiers ?? [] });
    return { how: `with a physical ${button} ${count > 1 ? `${count}× ` : ""}click at its center`, pending: false };
  }

  async click(args: ClickArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    let pending = false;
    if (args.x !== undefined && args.y !== undefined) {
      const point = await this.toScreen(state, args.x, args.y);
      await this.helper.call("click", {
        ...point,
        hwnd: state.hwnd,
        button: args.mouse_button ?? "left",
        count: args.click_count ?? 1,
        modifiers: args.modifiers ?? [],
      });
      summary.push(`Clicked at (${args.x}, ${args.y}) in the screenshot.`);
    } else {
      const { node, note: resolved } = await this.pick(state, args, "click");
      if (resolved) summary.push(resolved);
      const result = await this.clickNode(state, node, args);
      pending = result.pending;
      summary.push(`Clicked ${node.index} ${clean(node.name) || node.role} ${result.how}.`);
    }
    return this.outcome(state, before, beforeWindows, summary, args, pending);
  }

  async setValue(args: SetValueArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    const { node, note: resolved } = await this.pick(state, args, "set_value");
    if (resolved) summary.push(resolved);
    if (node.actions.includes("setValue")) {
      const result = await this.elementCall(state, node, "setValue", { value: args.value });
      summary.push(`Set ${node.index} ${clean(node.name) || node.role} to ${JSON.stringify(clean(args.value, 120))}.`);
      if (typeof result.value === "string" && result.value.trim() !== args.value.trim()) {
        summary.push(`Warning: the element now reads ${JSON.stringify(clean(result.value, 120))}, not the requested value.`);
      }
    } else if (node.role === "ComboBox" || node.role === "List") {
      summary.push(await this.chooseOption(state, node, args.value));
    } else if (node.focusable) {
      await this.elementCall(state, node, "focus");
      await this.helper.call("pressKey", { key: "ctrl+a", hwnd: state.hwnd });
      await this.helper.call("typeText", { text: args.value, hwnd: state.hwnd });
      summary.push(`Element ${node.index} has no settable value; focused it, selected all and typed the value instead.`);
    } else {
      throw new ToolError("not_settable", `Element ${node.index} (${node.role}) cannot hold a value. Use click or type_text.`);
    }
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  /** Pick an option of a combo box or list by its visible name. */
  private async chooseOption(state: WindowState, node: StateNode, value: string): Promise<string> {
    if (node.actions.includes("expand")) {
      await this.elementCall(state, node, "expand");
      await sleep(150);
      await this.refresh(state);
    }
    const wanted = value.trim().toLowerCase();
    const options: StateNode[] = [];
    const collect = (parent: StateNode) => {
      for (const child of parent.children) {
        if (child.actions.includes("select")) options.push(child);
        collect(child);
      }
    };
    collect(state.byIndex.get(node.index) ?? node);
    const option =
      options.find((candidate) => clean(candidate.name).toLowerCase() === wanted) ??
      options.find((candidate) => clean(candidate.name).toLowerCase().startsWith(wanted));
    if (!option) {
      if (node.actions.includes("collapse") || node.actions.includes("expand")) await this.elementCall(state, node, "collapse").catch(() => undefined);
      const names = options.slice(0, 15).map((candidate) => clean(candidate.name)).filter(Boolean);
      throw new ToolError("option_not_found", `No option "${value}" in ${node.index}.${names.length ? ` Options: ${names.join(", ")}.` : ""}`);
    }
    await this.elementCall(state, option, "select");
    if (state.byIndex.get(node.index)?.expandState === "expanded") await this.elementCall(state, node, "collapse").catch(() => undefined);
    return `Selected option ${JSON.stringify(clean(option.name))} in ${node.index} ${clean(node.name) || node.role}.`;
  }

  async typeText(args: TypeTextArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    if ((args.element_index !== undefined && args.element_index !== "") || args.target?.trim()) {
      const { node, note: resolved } = await this.pick(state, args, "type");
      if (resolved) summary.push(resolved);
      await this.elementCall(state, node, "focus");
      summary.push(`Focused ${node.index} ${clean(node.name) || node.role}.`);
    }
    const typed = await this.helper.call("typeText", { text: args.text, hwnd: state.hwnd });
    summary.push(`Typed ${typed.characters} characters.`);
    if (typed.unconfirmed > 0) {
      summary.push(`Warning: the app did not confirm ${typed.unconfirmed} of them in time; check the text below.`);
    }
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  async pressKey(args: PressKeyArgs): Promise<ToolOutput> {
    assertKeyAllowed(args.key);
    const { state, before, beforeWindows, note } = await this.begin(args);
    await this.helper.call("pressKey", { key: args.key, hwnd: state.hwnd, repeat: args.repeat ?? 1 });
    const summary = [...(note ? [note] : []), `Pressed ${args.key}${(args.repeat ?? 1) > 1 ? ` ×${args.repeat}` : ""}.`];
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  private scrollable(state: WindowState, node: StateNode): StateNode | undefined {
    if (node.actions.includes("scroll")) return node;
    return state.ancestors(node).find((ancestor) => ancestor.actions.includes("scroll"));
  }

  async scroll(args: ScrollArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    const pages = Math.max(args.pages ?? 1, 0.1);
    const notches = Math.max(1, Math.round(pages * 5));
    const wheel = (point: { x: number; y: number }) => {
      const vertical = args.direction === "up" || args.direction === "down";
      const sign = args.direction === "down" || args.direction === "right" ? 1 : -1;
      return this.helper.call("scroll", { ...point, hwnd: state.hwnd, dx: vertical ? 0 : sign * notches, dy: vertical ? sign * notches : 0 });
    };
    if (args.x !== undefined && args.y !== undefined) {
      await wheel(await this.toScreen(state, args.x, args.y));
      summary.push(`Scrolled ${args.direction} at (${args.x}, ${args.y}).`);
    } else {
      const { node, note: resolved } = await this.pick(state, args, "scroll");
      if (resolved) summary.push(resolved);
      const container = this.scrollable(state, node);
      if (container) {
        const whole = Number.isInteger(pages);
        await this.elementCall(state, container, "scroll", {
          direction: args.direction,
          page: whole,
          amount: whole ? pages : Math.max(1, Math.round(pages * 4)),
        });
        summary.push(`Scrolled ${container.index} ${clean(container.name) || container.role} ${args.direction} by ${pages} page(s) via UI Automation.`);
      } else {
        await wheel(await this.centerOf(state, node));
        summary.push(`Scrolled ${args.direction} with the mouse wheel over ${node.index}.`);
      }
    }
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  async drag(args: DragArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const from = await this.toScreen(state, args.from_x, args.from_y);
    const to = await this.toScreen(state, args.to_x, args.to_y);
    await this.helper.call("drag", { from, to, hwnd: state.hwnd });
    const summary = [...(note ? [note] : []), `Dragged from (${args.from_x}, ${args.from_y}) to (${args.to_x}, ${args.to_y}).`];
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  async secondaryAction(args: SecondaryArgs): Promise<ToolOutput> {
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    const { node, note: resolved } = await this.pick(state, args, "secondary");
    if (resolved) summary.push(resolved);
    const name = args.action.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    const label = `${node.index} ${clean(node.name) || node.role}`;
    const scroll = name.match(/^scroll (up|down|left|right)$/);
    if (scroll) {
      const container = this.scrollable(state, node) ?? node;
      await this.elementCall(state, container, "scroll", { direction: scroll[1] as Direction, page: true, amount: 1 });
      summary.push(`Scrolled ${container.index} ${scroll[1]} one page.`);
    } else if (["show menu", "context menu", "show context menu", "right click", "menu"].includes(name)) {
      try {
        await this.elementCall(state, node, "showContextMenu");
        summary.push(`Opened the context menu of ${label}.`);
      } catch {
        await this.helper.call("click", { ...(await this.centerOf(state, node)), hwnd: state.hwnd, button: "right" });
        summary.push(`Right-clicked ${label}.`);
      }
    } else if (name === "read text") {
      const result = await this.elementCall(state, node, "readText", { maxLength: 20_000 });
      return { text: `${[...summary, `Text of ${label}:`].join("\n")}\n${result.text ?? ""}` };
    } else {
      const mapping: Record<string, ElementActionName> = {
        expand: "expand",
        collapse: "collapse",
        toggle: "toggle",
        select: "select",
        "add to selection": "addToSelection",
        "remove from selection": "removeFromSelection",
        focus: "focus",
        raise: "focus",
        "scroll into view": "scrollIntoView",
        "scroll to visible": "scrollIntoView",
        invoke: "invoke",
        press: "invoke",
        "default action": "defaultAction",
      };
      const action = mapping[name];
      if (!action) {
        throw new ToolError(
          "unknown_action",
          `Unknown secondary action "${args.action}". Use one listed in the element's line, or: Expand, Collapse, Scroll Up/Down/Left/Right, Show Menu, Toggle, Select, Focus, Scroll Into View, Invoke, Read Text.`,
        );
      }
      const result = await this.elementCall(state, node, action);
      summary.push(`Performed ${args.action} on ${label}${result.pending ? " (the app is still handling it)" : ""}.`);
    }
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  /** Run several steps against one window and report once at the end. */
  async performActions(args: BatchArgs): Promise<ToolOutput> {
    if (!args.actions.length) throw new ToolError("bad_params", "Pass at least one action.");
    const { state, before, beforeWindows, note } = await this.begin(args);
    const summary: string[] = note ? [note] : [];
    const quiet: OutcomeArgs = { return_state: "none" };
    const scope = { app: args.app, window: state.hwnd };
    this.batch = state;
    try {
      for (const [position, step] of args.actions.entries()) {
        const label = `Step ${position + 1} (${step.action})`;
        try {
          const element = { element_index: step.element_index, target: step.target };
          let result: ToolOutput;
          switch (step.action) {
            case "click":
              result = await this.click({ ...scope, ...element, ...quiet, x: step.x, y: step.y, mouse_button: step.mouse_button, click_count: step.click_count });
              break;
            case "set_value":
              result = await this.setValue({ ...scope, ...element, ...quiet, value: step.value ?? step.text ?? "" });
              break;
            case "type_text":
              result = await this.typeText({ ...scope, ...element, ...quiet, text: step.text ?? step.value ?? "" });
              break;
            case "press_key":
              if (!step.key) throw new ToolError("bad_params", "press_key needs `key`.");
              result = await this.pressKey({ ...scope, ...quiet, key: step.key });
              break;
            case "scroll":
              result = await this.scroll({ ...scope, ...element, ...quiet, direction: step.direction ?? "down", pages: step.pages, x: step.x, y: step.y });
              break;
            case "perform_secondary_action":
              result = await this.secondaryAction({ ...scope, ...element, ...quiet, action: step.name ?? step.value ?? "" });
              break;
            case "drag":
              result = await this.drag({ ...scope, ...quiet, from_x: step.x ?? 0, from_y: step.y ?? 0, to_x: step.to_x ?? 0, to_y: step.to_y ?? 0 });
              break;
            case "wait":
              await sleep(Math.min(Math.max(step.ms ?? 500, 0), 10_000));
              result = { text: `Waited ${step.ms ?? 500} ms.` };
              break;
          }
          summary.push(`${label}: ${result.text.replace(/\n+/g, " ")}`);
        } catch (error) {
          summary.push(`${label} failed: ${errorMessage(error)}`);
          if (args.stop_on_error ?? true) {
            summary.push(`Stopped; ${args.actions.length - position - 1} step(s) not run.`);
            break;
          }
        }
      }
    } finally {
      this.batch = undefined;
    }
    return this.outcome(state, before, beforeWindows, summary, args);
  }

  async doctor(): Promise<ToolOutput> {
    const lines: string[] = [];
    const ping = await this.helper.call("ping", {});
    const built = this.platform.helperPath
      ? new Date(statSync(this.platform.helperPath).mtimeMs).toISOString().replace("T", " ").slice(0, 19)
      : "n/a";
    lines.push(`Helper: ocu-win ${ping.version} (${ping.platform}) at ${this.platform.helperPath}, built ${built} UTC`);
    const guard = await this.helper.call("guardStatus", {});
    lines.push(`Input guard: ${guard.enabled ? "on (physical Esc stops actions; user activity pauses input)" : "off"}`);
    lines.push(
      `Overlay: ${this.config.overlay ? `on (blue screen-edge glow while the agent works; hides after ${this.config.overlayIdleMs / 1000} s idle)` : "off"}`,
    );
    lines.push(`Approval mode: ${this.config.approval}; approved apps: ${this.config.approvedApps.join(", ") || "none"}`);
    const status = this.jev?.status();
    lines.push(`Jev: ${status ? (status.ready ? `ready (model ${status.model})` : status.reason) : "off"}`);
    const windows = await this.helper.call("listWindows", {});
    lines.push(`Visible app windows: ${windows.length}`);
    try {
      const last = JSON.parse(readFileSync(LAST_CLIENT_FILE, "utf8")) as { at: string; client?: { name: string; version: string }; elicitation: boolean };
      lines.push(
        `Last MCP client: ${last.client?.name ?? "unknown"} ${last.client?.version ?? ""} at ${last.at}; ` +
          (last.elicitation ? "it can show approval prompts." : "it cannot show approval prompts, so approve apps with the approve command."),
      );
    } catch {
      lines.push("Last MCP client: none recorded yet.");
    }
    return { text: lines.join("\n") };
  }
}
