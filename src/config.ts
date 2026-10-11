import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type ApprovalMode = "prompt" | "allowlist" | "off";
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
  jev: JevSettings;
};

export const DEFAULT_CONFIG: Config = {
  approval: "prompt",
  approvedApps: [],
  blockedApps: [],
  allowAgentApps: false,
  screenshots: "auto",
  screenshotMaxEdge: 1366,
  maxStateLines: 600,
  settleMs: 200,
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

/** How to run this CLI from a shell: the script itself when known, else the installed command. */
export function cliCommand(): string {
  const script = process.argv[1];
  return script && /[\\/]cli\.(mjs|ts)$/.test(script) ? `node "${script}"` : "open-cu";
}

export function configPath(): string {
  return process.env.OCU_CONFIG ?? join(homedir(), ".open-cu", "config.json");
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
  const approval = process.env.OCU_APPROVAL as ApprovalMode | undefined;
  if (approval && ["prompt", "allowlist", "off"].includes(approval)) config.approval = approval;
  const screenshots = process.env.OCU_SCREENSHOTS as ScreenshotMode | undefined;
  if (screenshots && ["auto", "always", "never"].includes(screenshots)) config.screenshots = screenshots;
  const jev = overrides.jev ?? envFlag("OCU_JEV");
  if (jev !== undefined) config.jev.enabled = jev;
  if (process.env.OCU_JEV_MODEL) config.jev.model = process.env.OCU_JEV_MODEL;
  return config;
}

/** Persist approved apps without disturbing other settings in the file. */
export function updateApprovedApps(change: (apps: string[]) => string[]): string[] {
  const path = configPath();
  const file = readFileConfig(path);
  const apps = change([...(file.approvedApps ?? [])]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...file, approvedApps: apps }, null, 2)}\n`);
  return apps;
}
