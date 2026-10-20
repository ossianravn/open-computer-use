import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ToolError } from "./errors.ts";
import { HelperClient } from "./helper.ts";

const run = promisify(execFile);

export type InstalledApp = { name: string; id: string; processName?: string; bundleId?: string };

/** What the server needs from a helper connection. */
export type Helper = Pick<HelperClient, "call" | "close">;

/** OS-specific pieces that live outside the helper protocol. */
export interface Platform {
  readonly name: string;
  readonly helper: Helper;
  /** The helper executable in use. */
  readonly helperPath: string;
  installedApps(): Promise<InstalledApp[]>;
  /** Open an installed app; macOS returns the process, including an existing app. */
  launch(app: InstalledApp | { program: string }): Promise<void | { pid: number }>;
  close(): void;
}

function packageRoot(): string {
  // src/platform.ts in development, dist/cli.mjs when bundled: both sit one level down.
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function windowsHelperPath(): string {
  if (process.env.OCU_WINDOWS_HELPER) return process.env.OCU_WINDOWS_HELPER;
  // The packaged copy (bin) and a fresh cargo build (target) can both exist in a
  // checkout; use whichever is newer so a rebuild is never shadowed by a stale copy.
  const found = [
    join(packageRoot(), "native", "windows", "bin", "ocu-win.exe"),
    join(packageRoot(), "native", "windows", "target", "release", "ocu-win.exe"),
  ]
    .filter((path) => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!found) {
    throw new ToolError(
      "helper_missing",
      `The Windows helper (ocu-win.exe) is not built. Run \`npm run build:native\` in ${packageRoot()} or set OCU_WINDOWS_HELPER.`,
    );
  }
  return found;
}

class WindowsPlatform implements Platform {
  readonly name = "windows";
  readonly helper: HelperClient;
  readonly helperPath: string;
  private installed: { at: number; apps: InstalledApp[] } | undefined;

  constructor() {
    this.helperPath = windowsHelperPath();
    this.helper = new HelperClient(this.helperPath);
  }

  async installedApps(): Promise<InstalledApp[]> {
    if (this.installed && Date.now() - this.installed.at < 5 * 60_000) return this.installed.apps;
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress"],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout || "[]") as { Name: string; AppID: string }[] | { Name: string; AppID: string };
    const apps = (Array.isArray(parsed) ? parsed : [parsed]).map((app) => ({ name: app.Name, id: app.AppID }));
    this.installed = { at: Date.now(), apps };
    return apps;
  }

  async launch(app: InstalledApp | { program: string }): Promise<void> {
    if ("id" in app) {
      // The shell resolves both packaged-app ids and desktop shortcuts here.
      spawn("explorer.exe", [`shell:AppsFolder\\${app.id}`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return;
    }
    // ShellExecute (Start-Process) also finds programs registered under App Paths.
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "& { Start-Process -FilePath $args[0] -ErrorAction Stop }", app.program],
      { windowsHide: true, timeout: 20_000 },
    ).catch((error: Error) => {
      throw new ToolError("launch_failed", `Could not start ${app.program}: ${error.message.split("\n")[0]}`);
    });
  }

  close(): void {
    this.helper.close();
  }
}

export function macosHelperPath(): string {
  if (process.platform === "darwin" && Number.parseInt(release(), 10) < 23) {
    throw new ToolError("unsupported_platform", "The macOS helper requires macOS 14 (Sonoma) or later. Upgrade macOS to use open-cu on this computer.");
  }
  const path = process.env.OCU_MACOS_HELPER ?? join(packageRoot(), "native", "macos", "bin", "ocu-mac");
  if (!existsSync(path)) {
    throw new ToolError("helper_missing", `The macOS helper (ocu-mac) is missing. Run \`npm run build:native\` in ${packageRoot()} with Xcode Command Line Tools installed, or set OCU_MACOS_HELPER.`);
  }
  return path;
}

class MacOSPlatform implements Platform {
  readonly name = "macos";
  readonly helperPath = macosHelperPath();
  readonly helper = new HelperClient(this.helperPath);
  private installed: { at: number; apps: InstalledApp[] } | undefined;

  async installedApps(): Promise<InstalledApp[]> {
    if (this.installed && Date.now() - this.installed.at < 5 * 60_000) return this.installed.apps;
    const apps = await this.helper.call("installedApps", {});
    this.installed = { at: Date.now(), apps };
    return apps;
  }

  async launch(app: InstalledApp | { program: string }): Promise<{ pid: number }> {
    if (!("id" in app)) {
      throw new ToolError("app_not_found", `No installed macOS app matches "${app.program}". Use list_apps with include_installed=true and choose an exact app name.`);
    }
    return await this.helper.call("launchApp", { id: app.id });
  }

  close(): void { this.helper.close(); }
}

/**
 * Stands in where no helper can run (another OS, or a missing build). The server still
 * starts, so clients list its tools; every call explains the problem instead.
 */
class UnavailablePlatform implements Platform {
  readonly helperPath = "";
  readonly helper: Helper;
  readonly name: string;

  constructor(name: string, problem: ToolError) {
    this.name = name;
    this.helper = { call: () => Promise.reject(problem), close: () => undefined };
  }

  installedApps(): Promise<InstalledApp[]> {
    return this.helper.call("ping", {}) as never;
  }

  launch(): Promise<void> {
    return this.helper.call("ping", {}) as never;
  }

  close(): void {}
}

export function createPlatform(): Platform {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    return new UnavailablePlatform(
      process.platform,
      new ToolError(
        "unsupported_platform",
        `open-cu supports Windows 10/11 and macOS 14+; there is no helper for ${process.platform} yet. Tell the user this tool cannot operate apps on this computer.`,
      ),
    );
  }
  try {
    return process.platform === "darwin" ? new MacOSPlatform() : new WindowsPlatform();
  } catch (error) {
    if (error instanceof ToolError) return new UnavailablePlatform(process.platform === "darwin" ? "macos" : "windows", error);
    throw error;
  }
}
