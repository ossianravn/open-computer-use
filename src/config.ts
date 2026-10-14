import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How apps get approved. Hard blocks (terminals, password managers, …) apply in every mode.
 * - all (default): every app is approved, so the agent is never stopped by a prompt.
 * - prompt: ask the user the first time an app is used (MCP elicitation); else the allowlist.
 * - allowlist: only apps in approvedApps.
 */
export type ApprovalMode = "prompt" | "allowlist" | "all";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["prompt", "allowlist", "all"];

/** Accepts the older name "off" for "all". */
export function parseApprovalMode(value: string | undefined): ApprovalMode | undefined {
  const mode = value?.trim().toLowerCase();
  if (mode === "off") return "all";
  return APPROVAL_MODES.find((known) => known === mode);
}
export type ScreenshotMode = "auto" | "always" | "never";

export type JevSettings = {
  /** Use Jev to resolve `target` descriptions and check `expect` outcomes. */
  enabled: boolean;
  model?: string;
  /** A .env file holding TYPESAFE_API_KEY (and optionally TYPESAFE_MODEL). */
  envFile?: string;
  /** Minimum Choice confidence, in both option orders, to act without asking. */
  minConfidence: number;
  /** Minimum probability that the described element exists at all. */
  minPresence: number;
  /** Most candidates sent in one Choice (the API allows 255). */
  maxCandidates: number;
  timeoutMs: number;
};

export type Config = {
  approval: ApprovalMode;
  /** Executable names (e.g. "notepad.exe") the user approved permanently. */
  approvedApps: string[];
  /** Extra executable names to refuse, on top of the built-in blocks. */
  blockedApps: string[];
  /** Allow driving AI agent host apps (Claude, ChatGPT, Codex). Off by default. */
  allowAgentApps: boolean;
  screenshots: ScreenshotMode;
  /** Longest edge of returned screenshots in pixels. */
  screenshotMaxEdge: number;
  /** Most accessibility lines rendered in one state. */
  maxStateLines: number;
  /** Wait after an action before reading the new state. */
  settleMs: number;
  /** Show a blue screen-edge glow and label while the agent uses the computer. */
  overlay: boolean;
  /** Hide the overlay after this long without agent activity. */
  overlayIdleMs: number;
  jev: JevSettings;
};

export const DEFAULT_CONFIG: Config = {
  approval: "all",
  approvedApps: [],
  blockedApps: [],
  allowAgentApps: false,
  screenshots: "auto",
  screenshotMaxEdge: 1366,
  maxStateLines: 600,
  settleMs: 200,
  overlay: true,
  overlayIdleMs: 15_000,
  jev: {
    enabled: false,
    minConfidence: 0.5,
    minPresence: 0.5,
    maxCandidates: 120,
    timeoutMs: 4000,
  },
};

/** Where the server records the last connected MCP client (name, version, capabilities; no content). */
export const LAST_CLIENT_FILE = join(tmpdir(), "open-cu", "last-client.json");

export function configPath(): string {
  return process.env.OCU_CONFIG ?? join(homedir(), ".open-cu", "config.json");
}

/** Where open-cu keeps its own files (the config file's folder). */
export function configDir(): string {
  return dirname(configPath());
}

function readFileConfig(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value);
}

/** Defaults, then the config file, then environment overrides. */
export function loadConfig(overrides: { jev?: boolean } = {}): Config {
  const file = readFileConfig(configPath());
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...file,
    jev: { ...DEFAULT_CONFIG.jev, ...file.jev },
  };
  config.approval = parseApprovalMode(file.approval) ?? DEFAULT_CONFIG.approval;
  const approval = parseApprovalMode(process.env.OCU_APPROVAL);
  if (approval) config.approval = approval;
  const screenshots = process.env.OCU_SCREENSHOTS as ScreenshotMode | undefined;
  if (screenshots && ["auto", "always", "never"].includes(screenshots)) config.screenshots = screenshots;
  const overlay = envFlag("OCU_OVERLAY");
  if (overlay !== undefined) config.overlay = overlay;
  const jev = overrides.jev ?? envFlag("OCU_JEV");
  if (jev !== undefined) config.jev.enabled = jev;
  if (process.env.OCU_JEV_MODEL) config.jev.model = process.env.OCU_JEV_MODEL;
  return config;
}

/** Change some settings in the config file, leaving the others as they are. */
function updateConfigFile(change: (file: Partial<Config>) => Partial<Config>): void {
  const path = configPath();
  const file = change(readFileConfig(path));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function updateApprovedApps(change: (apps: string[]) => string[]): string[] {
  let apps: string[] = [];
  updateConfigFile((file) => {
    apps = change([...(file.approvedApps ?? [])]);
    return { ...file, approvedApps: apps };
  });
  return apps;
}

export function setApprovalMode(mode: ApprovalMode): void {
  updateConfigFile((file) => ({ ...file, approval: mode }));
}

export function updateJevSettings(change: Partial<JevSettings>): void {
  updateConfigFile((file) => ({ ...file, jev: { ...file.jev, ...change } as JevSettings }));
}
