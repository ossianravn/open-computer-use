# Research: how Codex Computer Use works, and what others built

This is the design study behind open-computer-use. It summarizes OpenAI's Codex Computer
Use (as of October 2026) and three related projects, and records the decisions we took
from them. Facts come from public docs, the open-source `openai/codex` repo, third-party
reverse-engineering write-ups, and a read-only look at the Codex plugin bundle installed
on a Windows test machine. Nothing proprietary is copied here; API shapes are described
in our own words.

## 1. Codex Computer Use

### Timeline

| Date | Event |
|---|---|
| 2025-10 | OpenAI acquires Software Applications Inc., makers of the Mac agent **Sky**. Internal names still say Sky (`SkyComputerUseService`, `@oai/sky`, "skyshot"). |
| 2026-04 | Computer Use ships in the Codex app on macOS. Accessibility tree first, screenshots and coordinates as fallback. |
| 2026-05 | Chrome extension, then **Windows** support. Windows takes over the foreground pointer and keyboard; macOS can work in the background. |
| 2026-06 | Per-app access controls on Windows, faster browser use. |
| 2026-08 | Extension covers Edge, Brave, Opera, Vivaldi. |
| 2026-09 | Browser and desktop control move into one generated MCP server, `cua_repl`, whose only tools are `js` and `js_reset`. |

### Three generations of tool surface

1. **Direct MCP tools (macOS, from April 2026).** Server `computer-use`, ten tools keyed by
   `app` (name, path or bundle id): `list_apps`, `get_app_state`, `click`,
   `perform_secondary_action`, `set_value`, `select_text`, `scroll`, `drag`, `press_key`,
   `type_text`. `click` takes `element_index` *or* `x`,`y` in screenshot pixels, plus
   `click_count` and `mouse_button`. `scroll` takes an element, a direction and fractional
   `pages`. `press_key` uses xdotool key names (`Return`, `super+c`, `KP_0`).
   `get_app_state` returns the key window's screenshot plus an accessibility tree, and by
   default later states are **diffs** against the previous one.
2. **Skill + generic JS REPL + `@oai/sky` (Windows plugin).** The model imports a client
   inside a sandboxed Node REPL. The Windows client is **window-keyed**: `list_apps`,
   `list_windows`, `launch_app`, `activate_window`, `get_window_state`
   (`include_screenshot` on by default, `include_text` off by default), `click`,
   `press_key`, `type_text`, `scroll` (pixel deltas at a point), `set_value`, `drag`,
   `perform_secondary_action`. Coordinate actions carry the `screenshotId` they were read
   from, and the helper rejects points outside that capture or over another window.
3. **Unified `cua_repl` (current).** One persistent JS REPL tool (`js`) plus `js_reset`
   and a hidden `turn_ended`. A `cua` global binds apps (`cua.getApp({windowId})`), browser
   tabs and windows; targets expose `getAXState`, `getScreenshot`, `click(index | [x,y])`,
   `setValue`, `scroll`, `drag`, `performSecondaryAction`, `typeText`, `pressKey`. The
   first call returns ~11k tokens of API docs. Batching several actions and one final
   `getAXState()` into one `js` call is the main speed lever.

### Process model

- **macOS:** `SkyComputerUseClient` (stdio MCP) → Unix socket with length-framed JSON-RPC →
  `SkyComputerUseService` (signed Swift app holding the Accessibility and Screen Recording
  grants). Observation is a "skyshot": AX text plus screenshot.
- **Windows:** the JS client talks to `codex-computer-use.exe` over a named pipe owned by
  the Codex app (`\\.\pipe\codex-computer-use-<uuid>`), or spawns it and speaks NDJSON.
  The helper uses UI Automation, `SendInput` and Windows.Graphics.Capture (so occluded
  windows still capture). Default per-call timeout 10 s (15 s for app launch).
- **Browsers:** a Chrome/Edge extension plus native-messaging host gives CDP-level access
  (`attach`, `executeCdp`, tab claiming). Tabs the agent opens are closed at turn end
  unless marked as a deliverable or a hand-off.

### State representation

- Text, one element per line, tab-indented by depth:
  `<index> <role> (<states>) <name>, Description: …, Value: …, Secondary Actions: a, b, ID: …`.
- Roles are lower-case words (`button`, `text field`, `combo box`, `tree item`). States
  include `focused`, `selected`, `expanded`/`collapsed`, `settable`, `disabled`,
  `on`/`off`. The tree is followed by the focused element and any selected text.
- Generic containers are collapsed and adjacent text merged. Element indices are valid
  only for the observation that produced them. The Windows helper re-checks each index
  against its cached snapshot and the element's UIA runtime id before acting.
- Screenshots are JPEG; coordinates are window-relative screenshot pixels.

### Safety model

- **Per-app approval** through MCP elicitation ("Allow Codex to use <App>?") with
  once / session / always scopes and a risk level. Approvals persist in config.
- **Hard blocks** that no approval overrides: terminals and the Run dialog, password
  managers, security and antivirus software, sign-in and UAC prompts, security and privacy
  settings, Windows-key shortcuts, age verification, and the Codex app itself.
- **Confirmation policy** in four tiers: hand off (passwords, security bypass), confirm at
  action time (deletion, purchases, messages, installs), pre-approval allowed (logins,
  uploads to a named destination), no confirmation (cookie banners, downloads).
- **User interruption:** a physical Esc ends computer use for the turn; physical input on
  the target window blocks synthetic input until the next observation. An overlay shows
  that the agent is in control.
- A reviewer model ("Guardian") can audit REPL calls against the actual UI state.

### Open vs closed

`openai/codex` (Apache-2.0) contains only host plumbing: config and policy schema,
elicitation metadata, turn metadata (`_meta["x-codex-turn-metadata"]`), cleanup hooks and
the policy text. The helpers, the `@oai/*` packages, the REPL binary and the extension are
proprietary.

## 2. Related projects

### ifuryst/open-codex-computer-use (MIT, ~2.4k stars, v1.0.0)

An open re-implementation of the ten-tool direct surface, primarily for macOS (Swift, AX
API, private SkyLight capture/input paths). Windows and Linux are experimental Go servers
that start a fresh PowerShell or Python process per tool call.

- **Borrowed:** Codex-compatible tool names and parameters so prompts transfer; explicit
  reporting of how an action was delivered; refusing coordinate input without a
  screenshot; a deterministic fixture app for tests.
- **Gaps we fix on Windows:** per-call PowerShell cold starts; managed UIA tree walks
  instead of cached COM requests; `CopyFromScreen` captures whatever covers the window;
  not DPI-aware; only the main window is reachable; indices are not tied to a window or
  snapshot (silent wrong-window actions); `set_value` reports success without checking;
  no denylist and no approval layer; every action returns the full tree plus a 1280 px
  image (a user measured 240–355k tokens for a simple form).

### amontlabs/lcu ("Linux Computer Use", MIT, v0.11)

Not a re-implementation: a bridge that launches OpenAI's own `cua_repl` runtime from the
installed ChatGPT/Codex app and serves it to Claude Code, Codex CLI and others. Useful as
a map of the real surface and of host-integration problems.

- **Borrowed:** turn lifecycle wired to host hooks; approval scopes plus a guard that
  stops an agent approving its own host app; an input-safety wrapper (one input queue,
  release held keys after a timeout, refuse points outside the target window); a
  privacy-safe diagnostic log (metadata only, never UI text).
- **Not borrowed:** dependence on a proprietary runtime that breaks on app updates.

### openai/codex

See "Open vs closed" above. The policy schema (`default_app_access`, allow/deny lists by
executable or AUMID, persistent approval) informed our config format.

## 3. TypeSafe Jev

Jev is TypeSafe's fast "System One" judgment model. It returns typed answers with
probabilities instead of text: **Choice** (one of up to 255 options), **Noul**
(probability of yes) and **Score** (position on 2–10 ordered levels). One request can
carry many independent questions over shared state.

- Endpoint `POST https://api.typesafe.ai/v1/systemone`, bearer token; JS SDK
  `@typesafe-ai/sdk`. Model `jev-latest` (currently `jev-1.13.0`).
- Latency is typically 100–300 ms, including a 182-option Choice. Price is about
  $0.04 per million input tokens; output is free.
- Limits: 64k tokens per request, 32k for state plus the longest question, text only.
- Documented caveats: a Choice always picks something (pair it with a "none" option or an
  existence Noul); jev-1.13 leans toward the first option (re-ask in reversed order and
  require agreement); numbers and coordinates are weak inputs (describe position in
  words); text inside state can try to steer the answer (treat UI text as untrusted and
  never let a pick alone authorize a destructive action).

See [jev.md](jev.md) for how open-computer-use uses it.

## 4. Decisions

| Question | Decision | Why |
|---|---|---|
| Agent integration | MCP server (stdio) plus a CLI that calls the same tools | Works in Claude Code, Codex, Cursor, Gemini CLI and anything that can run a command. |
| Tool surface | Codex's direct tools (`list_apps`, `get_app_state`, `click`, …) keyed by `app`, with an optional `window` | Prompts and model habits from Codex transfer; `window` fixes multi-window ambiguity. |
| Native layer (Windows) | Persistent Rust helper over NDJSON: UIA COM with one cached subtree request per snapshot, `SendInput`, `PrintWindow(PW_RENDERFULLCONTENT)` with DPI correction | 50 ms snapshots and 30 ms actions instead of PowerShell cold starts; no occlusion leaks. |
| Element indices | Stable per window, keyed by UIA runtime id | Indices survive refreshes, so diffs stay small and old indices stay valid while the element exists. |
| Observation cost | Diffs after actions, screenshots only when asked or when the tree is too thin | The biggest complaint about existing open versions is token cost. |
| Action delivery | UIA patterns first (Invoke, Toggle, Select, Expand, Value), physical input as fallback, the method reported in the result | Pattern actions are fast, precise and work without moving the user's cursor. |
| Batching | A `perform_actions` tool that runs a list of steps and returns one final diff | Most of the REPL's speed benefit without executing model-written code. |
| Jev | Optional resolver: `target` descriptions on actions, `find_element`, `expect` checks | Lets the agent act without reading the whole tree; see [jev.md](jev.md). |
| Safety | Hard blocks (terminals by window class, password managers, security tools, sign-in prompts, Windows key), per-app approval via elicitation or allowlist, physical-Esc stop and user-activity back-off | Codex parity on the rules that matter, without its proprietary pieces. |
