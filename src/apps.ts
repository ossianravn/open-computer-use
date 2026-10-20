// Turning the agent's `app` / `window` arguments into one concrete top-level window.

import { ToolError } from "./errors.ts";
import type { WindowInfo } from "./protocol.ts";

/** Everyday names for common apps, mapped to their executables. */
const ALIASES: Record<string, string> = {
  chrome: "chrome.exe",
  "google chrome": "chrome.exe",
  edge: "msedge.exe",
  "microsoft edge": "msedge.exe",
  firefox: "firefox.exe",
  brave: "brave.exe",
  explorer: "explorer.exe",
  "file explorer": "explorer.exe",
  notepad: "notepad.exe",
  word: "winword.exe",
  "microsoft word": "winword.exe",
  excel: "excel.exe",
  "microsoft excel": "excel.exe",
  powerpoint: "powerpnt.exe",
  outlook: "olk.exe",
  "classic outlook": "outlook.exe",
  teams: "ms-teams.exe",
  "microsoft teams": "ms-teams.exe",
  code: "code.exe",
  vscode: "code.exe",
  "vs code": "code.exe",
  "visual studio code": "code.exe",
  settings: "systemsettings.exe",
  calculator: "calculatorapp.exe",
  paint: "mspaint.exe",
  "fl studio": "fl64.exe",
  "docker desktop": "docker desktop.exe",
};

const MACOS_ALIASES: Record<string, string> = {
  chrome: "Google Chrome", "google chrome": "Google Chrome", edge: "Microsoft Edge", "microsoft edge": "Microsoft Edge",
  firefox: "firefox", brave: "Brave Browser", safari: "Safari", finder: "Finder", textedit: "TextEdit",
  word: "Microsoft Word", excel: "Microsoft Excel", powerpoint: "Microsoft PowerPoint", outlook: "Microsoft Outlook",
  teams: "MSTeams", code: "Code", vscode: "Code", "vs code": "Code", "visual studio code": "Code",
  settings: "System Settings", calculator: "Calculator", "docker desktop": "Docker Desktop",
};

function stripExe(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

export function parseWindowId(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return value;
  const text = value.trim();
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ToolError("bad_params", `"${value}" is not a window id.`);
  return parsed;
}

/** Score how well a window matches an app query; 0 means no match. */
export function matchScore(window: WindowInfo, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const process = window.processName.toLowerCase();
  const title = window.title.toLowerCase();
  if (/^\d+$/.test(q) && window.pid === Number(q)) return 100;
  const alias = ALIASES[q];
  if (alias && process === alias) return 100;
  if (MACOS_ALIASES[q]?.toLowerCase() === process) return 100;
  if (window.bundleId?.toLowerCase() === q) return 100;
  if (process === q || stripExe(process) === stripExe(q)) return 100;
  if (window.exePath && window.exePath.toLowerCase() === q) return 100;
  if (title === q) return 90;
  const words = new RegExp(`(^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
  if (words.test(title)) return 70;
  if (stripExe(process).includes(stripExe(q))) return 50;
  if (title.includes(q)) return 40;
  return 0;
}

export type Resolved = { window: WindowInfo; note?: string; others: WindowInfo[] };

/**
 * Pick the window for `app` (and optional `window` id). `all` must include dialogs and
 * other owned windows. When the best match is blocked by a modal dialog, the dialog is
 * returned instead, because that is where input goes.
 */
export function resolveWindow(all: WindowInfo[], appWindows: WindowInfo[], app: string | undefined, windowId?: number): Resolved {
  let window: WindowInfo | undefined;
  if (windowId !== undefined) {
    window = all.find((candidate) => candidate.hwnd === windowId);
    if (!window) throw new ToolError("window_not_found", `No window with id ${windowId}. Call list_apps to see current windows.`);
    if (app && matchScore(window, app) === 0 && !all.some((other) => other.pid === window!.pid && matchScore(other, app) > 0)) {
      throw new ToolError("window_mismatch", `Window ${windowId} does not belong to "${app}". Call list_apps to see current windows.`);
    }
  } else {
    if (!app?.trim()) throw new ToolError("bad_params", "Pass `app` (a name, executable or window title) or `window` (an id from list_apps).");
    const ranked = appWindows
      .map((candidate, order) => ({ candidate, order, score: matchScore(candidate, app) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order);
    window = ranked[0]?.candidate;
    if (!window) {
      throw new ToolError(
        "app_not_found",
        `No open window matches "${app}". Call list_apps to see running apps, or launch_app to start it.`,
      );
    }
  }

  let note: string | undefined;
  if (!window.enabled) {
    const dialog = all.find((candidate) => candidate.owner === window!.hwnd && candidate.enabled && !candidate.minimized);
    if (dialog) {
      note = `A dialog ("${dialog.title}") is blocking ${window.title ? `"${window.title}"` : "the window"}; using the dialog (window ${dialog.hwnd}).`;
      window = dialog;
    }
  }
  const chosen = window;
  const others = all.filter((candidate) => candidate.pid === chosen.pid && candidate.hwnd !== chosen.hwnd && candidate.title);
  return note ? { window: chosen, note, others } : { window: chosen, others };
}

export function displayName(window: WindowInfo): string {
  const exe = window.processName.toLowerCase();
  const alias = Object.entries(ALIASES).find(([, target]) => target === exe)?.[0];
  if (alias) return alias.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
  return window.processName.replace(/\.exe$/i, "") || `pid ${window.pid}`;
}

export function aliasExe(name: string, platform = "windows"): string | undefined {
  return (platform === "macos" ? MACOS_ALIASES : ALIASES)[name.trim().toLowerCase()];
}
