import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ToolError } from "./errors.ts";
import { HelperClient } from "./helper.ts";

const run = promisify(execFile);

export type InstalledApp = { name: string; id: string };

/** OS-specific pieces that live outside the helper protocol. */
export interface Platform {
  readonly name: string;
  readonly helper: HelperClient;
  installedApps(): Promise<InstalledApp[]>;
  /** Start an installed app by Start-menu id, or a bare program name the shell resolves. */
  launch(app: InstalledApp | { program: string }): Promise<void>;
  close(): void;
}

function packageRoot(): string {
  // src/platform.ts in development, dist/cli.mjs when bundled: both sit one level down.
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function windowsHelperPath(): string {
  const candidates = [
    process.env.OCU_WINDOWS_HELPER,
    join(packageRoot(), "native", "windows", "bin", "ocu-win.exe"),
    join(packageRoot(), "native", "windows", "target", "release", "ocu-win.exe"),
  ].filter((path): path is string => !!path);
  const found = candidates.find((path) => existsSync(path));
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
  private installed: { at: number; apps: InstalledApp[] } | undefined;

  constructor() {
    this.helper = new HelperClient(windowsHelperPath());
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

export function createPlatform(): Platform {
  if (process.platform === "win32") return new WindowsPlatform();
  throw new ToolError(
    "unsupported_platform",
    `open-computer-use has no helper for ${process.platform} yet. The helper protocol is documented in docs/architecture.md.`,
  );
}
