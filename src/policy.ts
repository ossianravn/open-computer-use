import { type Config, configPath, setApprovalMode, updateApprovedApps } from "./config.ts";
import { ToolError } from "./errors.ts";
import type { WindowInfo } from "./protocol.ts";

export type AppIdentity = { exe: string; label: string };

export function appIdentity(window: Pick<WindowInfo, "processName" | "title" | "pid">): AppIdentity {
  const exe = (window.processName || `pid-${window.pid}`).toLowerCase();
  return { exe, label: window.processName.replace(/\.exe$/i, "") || window.title };
}

export type BlockReason = { code: "app_blocked"; message: string };

/** Only the apps the user listed in `blockedApps` are refused; nothing is blocked by default. */
export function blockReason(window: WindowInfo, config: Config): BlockReason | undefined {
  const exe = window.processName.toLowerCase();
  const bundleId = window.bundleId?.toLowerCase();
  if (!config.blockedApps.some((name) => [exe, bundleId].includes(name.toLowerCase()))) return undefined;
  return {
    code: "app_blocked",
    message: `The user blocked ${window.processName || window.title} in their open-cu config ("blockedApps"). Ask the user to do this step themselves.`,
  };
}

export function assertNotBlocked(window: WindowInfo, config: Config): void {
  const reason = blockReason(window, config);
  if (reason) throw new ToolError(reason.code, reason.message);
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
 * Per-app approval. The default mode, "all", approves every app. In "prompt" and "allowlist" modes, approvals live in the user's config
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
