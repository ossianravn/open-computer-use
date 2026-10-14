import { type Config, configPath, setApprovalMode, updateApprovedApps } from "./config.ts";
import { ToolError } from "./errors.ts";
import type { WindowInfo } from "./protocol.ts";

// Hard blocks. No approval or config overrides these; they mirror the categories Codex
// Computer Use refuses (terminals, password managers, security software, sign-in and
// elevation prompts) because acting there can bypass the user's own safeguards.

const TERMINAL_PROCESSES = [
  "windowsterminal.exe", "wt.exe", "openconsole.exe", "conhost.exe", "cmd.exe", "wsl.exe", "wslhost.exe",
  "mintty.exe", "alacritty.exe", "wezterm-gui.exe", "wezterm.exe", "putty.exe", "kitty.exe", "hyper.exe",
  "tabby.exe", "conemu.exe", "conemu64.exe", "cmder.exe", "fluentterminal.app.exe", "warp.exe", "ghostty.exe",
];

/** Console windows hosted by any process (a PowerShell window belongs to conhost/Terminal). */
const TERMINAL_WINDOW_CLASSES = ["consolewindowclass", "cascadia_hosting_window_class", "pseudoconsolewindow", "virtualconsoleclass"];

const PASSWORD_MANAGERS = [
  "1password.exe", "bitwarden.exe", "keepass.exe", "keepassxc.exe", "lastpass.exe", "dashlane.exe",
  "nordpass.exe", "protonpass.exe", "proton pass.exe", "enpass.exe", "roboform.exe", "keeper.exe",
  "keeperpasswordmanager.exe", "passwordboss.exe", "stickypassword.exe", "zoho vault.exe",
];

const SECURITY_AND_SYSTEM = [
  "sechealthui.exe", "securityhealthhost.exe", "msmpeng.exe", "mpcmdrun.exe", "consent.exe",
  "credentialuibroker.exe", "logonui.exe", "lockapp.exe", "useraccountcontrolsettings.exe", "regedit.exe",
  "mmc.exe", "gpedit.exe", "secpol.exe", "msconfig.exe", "taskmgr.exe", "bdagent.exe", "avastui.exe",
  "avgui.exe", "mcuicnt.exe", "nortonsecurity.exe", "ekrn.exe", "egui.exe", "mbam.exe", "malwarebytes.exe",
  "csfalconcontainer.exe", "sentinelui.exe", "kavtray.exe", "avp.exe", "sophosui.exe",
];

/** Programs launch_app never starts: shells and script hosts run arbitrary commands. */
export const LAUNCH_DENIED = [
  "cmd.exe", "powershell.exe", "pwsh.exe", "powershell_ise.exe", "bash.exe", "wsl.exe", "wscript.exe",
  "cscript.exe", "mshta.exe", "rundll32.exe", "regsvr32.exe", "msiexec.exe", "python.exe", "node.exe",
];

/** AI agent hosts: driving them could let an agent approve its own requests. */
const AGENT_APPS = ["claude.exe", "chatgpt.exe", "codex.exe"];

export type AppIdentity = { exe: string; label: string };

export function appIdentity(window: Pick<WindowInfo, "processName" | "title" | "pid">): AppIdentity {
  const exe = (window.processName || `pid-${window.pid}`).toLowerCase();
  return { exe, label: window.processName.replace(/\.exe$/i, "") || window.title };
}

export type BlockReason = { code: "app_blocked"; message: string };

export function blockReason(window: WindowInfo, config: Config): BlockReason | undefined {
  const exe = window.processName.toLowerCase();
  const className = window.className.toLowerCase();
  const refuse = (why: string): BlockReason => ({
    code: "app_blocked",
    message: `open-cu is not allowed to use ${window.processName || window.title} (${why}). Ask the user to do this step themselves.`,
  });
  if (TERMINAL_PROCESSES.includes(exe) || TERMINAL_WINDOW_CLASSES.includes(className)) {
    return refuse("terminals are never driven; use your own shell tool, where the user's permissions apply");
  }
  if (PASSWORD_MANAGERS.includes(exe)) return refuse("password managers are off limits");
  if (SECURITY_AND_SYSTEM.includes(exe)) return refuse("security, sign-in and system administration tools are off limits");
  if (!config.allowAgentApps && AGENT_APPS.includes(exe)) return refuse("AI agent apps are off limits");
  if (config.blockedApps.some((name) => name.toLowerCase() === exe)) return refuse("blocked in the user's config");
  return undefined;
}

export function assertNotBlocked(window: WindowInfo, config: Config): void {
  const reason = blockReason(window, config);
  if (reason) throw new ToolError(reason.code, reason.message);
}

/** Key chords that reach the OS shell rather than the app. */
export function assertKeyAllowed(key: string): void {
  const parts = key.toLowerCase().split("+").map((part) => part.trim());
  if (parts.some((part) => ["super", "super_l", "super_r", "win", "windows", "meta"].includes(part))) {
    throw new ToolError(
      "key_blocked",
      "Windows-key shortcuts are not allowed: they reach the OS shell (Run dialog, settings, lock screen). On Windows, use ctrl where macOS uses cmd.",
    );
  }
  if (parts.includes("ctrl") && parts.includes("alt") && (parts.includes("delete") || parts.includes("del"))) {
    throw new ToolError("key_blocked", "Ctrl+Alt+Delete is not allowed.");
  }
}

/**
 * The user's answer to an approval prompt. "all" approves every app from now on;
 * "dismissed" means the prompt was closed or never shown (some clients cancel prompts
 * they cannot display), which is not a refusal.
 */
export type ApprovalDecision = "session" | "always" | "all" | "deny" | "dismissed";

/** Ask the user (via MCP elicitation) whether to allow an app. Undefined when the client cannot ask. */
export type AskUser = (app: AppIdentity, window: WindowInfo) => Promise<ApprovalDecision | undefined>;

/** Current approval settings from disk, so CLI changes apply without a restart. */
export type ReloadApprovals = () => Pick<Config, "approval" | "approvedApps">;

/**
 * Per-app approval. The default mode, "all", approves every app (hard blocks still
 * apply). In "prompt" and "allowlist" modes, approvals live in the user's config
 * (always) or this session (session). Agents cannot approve apps: only the user,
 * through the client's prompt, the CLI or the config file.
 */
export class Approvals {
  private readonly session = new Set<string>();
  private readonly config: Config;
  private readonly askUser: AskUser | undefined;
  private readonly reload: ReloadApprovals | undefined;

  constructor(config: Config, askUser?: AskUser, reload?: ReloadApprovals) {
    this.config = config;
    this.askUser = askUser;
    this.reload = reload;
  }

  isApproved(app: AppIdentity): boolean {
    return (
      this.config.approval === "all" ||
      this.session.has(app.exe) ||
      this.config.approvedApps.some((name) => name.toLowerCase() === app.exe)
    );
  }

  async ensure(window: WindowInfo): Promise<void> {
    const app = appIdentity(window);
    if (this.reload && !this.isApproved(app)) {
      try {
        const fresh = this.reload();
        this.config.approval = fresh.approval;
        this.config.approvedApps = fresh.approvedApps;
      } catch {
        // Keep the settings the server started with.
      }
    }
    if (this.isApproved(app)) return;
    if (this.config.approval === "prompt" && this.askUser) {
      const decision = await this.askUser(app, window);
      if (decision === "all") {
        this.config.approval = "all";
        setApprovalMode("all");
        return;
      }
      if (decision === "session" || decision === "always") {
        this.session.add(app.exe);
        if (decision === "always") {
          this.config.approvedApps = updateApprovedApps((apps) => (apps.includes(app.exe) ? apps : [...apps, app.exe]));
        }
        return;
      }
      if (decision === "deny") {
        throw new ToolError("app_not_approved", `The user declined access to ${app.label}. Do not retry; ask the user how to proceed.`);
      }
      if (decision === "dismissed") {
        throw new ToolError(
          "app_not_approved",
          `The approval prompt for ${app.label} was closed or could not be shown, so it was not approved. ` +
            `Tell the user they can approve it with \`open-cu approve ${app.exe}\`, or approve every app with ` +
            `\`open-cu approval all\` (the default); then retry.`,
        );
      }
    }
    throw new ToolError(
      "app_not_approved",
      `open-cu needs the user's permission to use ${app.label}. Ask the user to approve it by running ` +
        `\`open-cu approve ${app.exe}\` (or \`open-cu approval all\` to approve every app), or by adding "${app.exe}" to ` +
        `"approvedApps" in ${configPath()}; then retry.`,
    );
  }
}
