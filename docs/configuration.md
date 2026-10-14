# Configuration

open-cu reads `~/.open-cu/config.json` (or the file named by `OCU_CONFIG`). Every setting is
optional; environment variables override the file. The `open-cu` command changes the
common ones for you:

| Command | Effect |
|---|---|
| `open-cu approve <app.exe>` | Add the app to `approvedApps`. |
| `open-cu revoke <app.exe>` | Remove it from `approvedApps`. |
| `open-cu approval [prompt\|allowlist\|all]` | Show or set `approval`. |
| `open-cu jev setup` | Save a TypeSafe key to `~/.open-cu/jev.env` and turn Jev on. |
| `open-cu jev on [--env-file <path>]` | Turn Jev on, optionally with another key file. |
| `open-cu jev off` | Turn Jev off. |
| `open-cu jev status` | Show where the key comes from and check it. |
| `open-cu config` | Print the file path and the effective settings. |
| `open-cu doctor` | Check the helper, input guard, overlay, approvals, Jev and the last client. |

## Settings

```json
{
  "approval": "all",
  "approvedApps": [],
  "blockedApps": [],
  "allowAgentApps": false,
  "screenshots": "auto",
  "screenshotMaxEdge": 1366,
  "maxStateLines": 600,
  "settleMs": 200,
  "overlay": true,
  "overlayIdleMs": 15000,
  "jev": {
    "enabled": false,
    "envFile": "C:/Users/you/.open-cu/jev.env",
    "model": "jev-latest",
    "minConfidence": 0.5,
    "minPresence": 0.5,
    "maxCandidates": 120,
    "timeoutMs": 4000
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `approval` | `all` | `all`: every app, so the agent is never stopped by a prompt. `prompt`: ask the first time each app is used (or report how to approve it when the client cannot ask). `allowlist`: only `approvedApps`. Hard blocks apply in every mode. |
| `approvedApps` | `[]` | Executable names approved permanently (used by `prompt` and `allowlist`). |
| `blockedApps` | `[]` | Extra executables to refuse, on top of the built-in blocks. |
| `allowAgentApps` | `false` | Allow driving AI agent apps (Claude, ChatGPT, Codex). |
| `screenshots` | `auto` | When `get_app_state` attaches a screenshot: `auto` (only when the tree is sparse), `always` or `never`. |
| `screenshotMaxEdge` | `1366` | Longest edge of returned screenshots, in pixels. |
| `maxStateLines` | `600` | Most lines in one rendered state; longer views end with an explicit marker. |
| `settleMs` | `200` | Wait after an action before reading the changes. |
| `overlay` | `true` | Show the blue screen-edge glow and "open-cu is using …" label while the agent works. |
| `overlayIdleMs` | `15000` | Hide the overlay after this long without agent activity. |
| `jev.enabled` | `false` | Resolve `target` descriptions with Jev and check `expect`. |
| `jev.envFile` | — | A `.env` file holding `TYPESAFE_API_KEY`. |
| `jev.model` | `jev-latest` | Pin a model version for stable behaviour. |
| `jev.minConfidence` | `0.5` | Weaker of the two Choice confidences needed to act. |
| `jev.minPresence` | `0.5` | Probability that the described element exists, needed to act. |
| `jev.maxCandidates` | `120` | Options per Choice (the API allows 255). |
| `jev.timeoutMs` | `4000` | Per Jev request; one retry. |

The Jev key is looked up in this order:

1. `TYPESAFE_API_KEY`
2. `jev.envFile`
3. `OCU_ENV_FILE`
4. `JEV_9000_ENV_FILE`

## Environment variables

| Variable | Values | Effect |
|---|---|---|
| `OCU_CONFIG` | path | Use another config file. |
| `OCU_APPROVAL` | `prompt`, `allowlist`, `all` | Override `approval`. |
| `OCU_SCREENSHOTS` | `auto`, `always`, `never` | Override `screenshots`. |
| `OCU_JEV` | `1` / `0` | Turn Jev on or off for this process. |
| `OCU_JEV_MODEL` | model id | Override `jev.model`. |
| `OCU_OVERLAY` | `1` / `0` | Turn the overlay on or off. |
| `OCU_OVERLAY_CAPTURE` | `1` | Let screen capture see the overlay, for documentation screenshots. |
| `OCU_GUARD` | `0` | Turn off the physical-input guard (Esc stop and back-off). |
| `OCU_STOP_LATCH_MS` | ms (default 20000) | How long an Esc press keeps actions stopped. |
| `OCU_USER_ACTIVE_MS` | ms (default 700) | How long physical input pauses synthetic input. |
| `OCU_KEY_DELAY_MS` | ms (default 5) | Pause between typed keys. |
| `OCU_WINDOWS_HELPER` | path | Use another `ocu-win.exe`. |
| `TYPESAFE_API_KEY` | key | The Jev key (takes precedence over files). |

The command-line flags `--jev` and `--no-jev` override Jev for one run.
