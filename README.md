# open-computer-use

Open, agent-agnostic computer use. Any agent that speaks MCP (Claude Code, Codex,
Cursor, Gemini CLI and others), or that can run a shell command, can read and operate
desktop apps through their accessibility tree, the way OpenAI's Codex Computer Use does.
None of OpenAI's code is used.

An optional fast path uses **[TypeSafe Jev](https://docs.typesafe.ai)**, a small judgment
model. The agent can say *what* to click ("the Save button", "the 7 key") instead of
reading the whole tree to find an index. Jev picks the element in about 250–400 ms and
can check that the action had the expected effect.

```text
> click(app: "calculator", target: "the 7 key")          # Windows set to Danish
Target "the 7 key" → 44 button Syv, ID: num7Button (Jev, confidence 1.00, 318 ms).
Clicked 44 Syv via UI Automation (invoke).
Changes (+ added, - removed, ~ changed):
~ 12 text Skærm er 7, ID: CalculatorResults
```

Status: **Windows works today** (Windows 10/11, x64). The helper protocol is
platform-neutral; macOS and Linux helpers are next (see [Roadmap](#roadmap)).

## Why another one

Codex Computer Use is closed and tied to the Codex app. The open versions we studied
either bridge to OpenAI's proprietary runtime
([amontlabs/lcu](https://github.com/amontlabs/lcu)), or are macOS-first with a thin
Windows port ([ifuryst/open-codex-computer-use](https://github.com/ifuryst/open-codex-computer-use)).
On Windows, that port starts PowerShell for every call, captures whatever covers the
window, is not DPI-aware, and spends hundreds of thousands of tokens on a simple form,
because every action returns the full tree plus a screenshot. [docs/research.md](docs/research.md)
has the full study.

open-computer-use keeps Codex's tool names and text format, so prompts and model habits
carry over, and changes what is underneath:

| | open-computer-use |
|---|---|
| Native layer | A persistent Rust helper using UI Automation COM, one cached request per snapshot. Takes 50 ms on a form and 145 ms on a long Wikipedia article. |
| Element indices | Stable for as long as an element exists, keyed by its UIA runtime id. Old indices keep working after a refresh. |
| After an action | Only the lines that changed. Screenshots only on request, or when the tree is too thin to work from. |
| Web pages | Off-screen content is filtered inside UIA. Links are written inline (`see [Personal computer](#87).`), so a Wikipedia screen is about 65 lines. |
| Clicking | UIA patterns first (invoke, toggle, select, expand), so most clicks never move the user's pointer. A real mouse click is the fallback, and the result says which was used. |
| Multi-step | `perform_actions` runs a list of steps and reports once. |
| Targeting | `target: "…"` resolves by exact name, then by Jev or word matching. It acts only on a clear winner; otherwise it returns candidates and does nothing. |
| Safety | Per-app approval through MCP elicitation, hard blocks (terminals, password managers, security tools, sign-in prompts, AI agent apps, Windows-key chords), and a physical Esc stop. It backs off while the user is typing or clicking. |

## Quick start (Windows)

You need Node 22.18+ and a Rust toolchain (`rustup`).

```bash
git clone https://github.com/ossianravn/open-computer-use.git
```

```bash
cd open-computer-use && npm install && npm run build
```

```bash
node dist/cli.mjs doctor
```

`doctor` checks the helper, the input guard, approvals and Jev.

### Connect an agent

Every agent runs the same stdio MCP server, `node <repo>/dist/cli.mjs mcp`. Add `--jev`
to turn on Jev targeting.

**Claude Code**

```bash
claude mcp add open-computer-use --scope user -- node C:/path/to/open-computer-use/dist/cli.mjs mcp --jev
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.open-computer-use]
command = "node"
args = ["C:/path/to/open-computer-use/dist/cli.mjs", "mcp", "--jev"]
```

**Any MCP client** (JSON config)

```json
{
  "mcpServers": {
    "open-computer-use": {
      "command": "node",
      "args": ["C:/path/to/open-computer-use/dist/cli.mjs", "mcp", "--jev"],
      "env": { "JEV_9000_ENV_FILE": "C:/Users/you/.jev-9000/config.env" }
    }
  }
}
```

**No MCP?** The CLI runs every tool, and element indices persist between invocations:

```bash
node dist/cli.mjs state notepad
```

```bash
node dist/cli.mjs call click '{"app":"notepad","target":"File menu"}'
```

Agents get usage guidance from the server's MCP instructions. For hosts with skills
(Claude Code, Codex), install [skills/open-computer-use/SKILL.md](skills/open-computer-use/SKILL.md) too.

## Tools

| Tool | What it does |
|---|---|
| `list_apps` | Running apps, their window ids and approval state. Add `include_installed` for Start-menu apps. |
| `launch_app` | Start an installed app by name. Localized names and package ids both work. |
| `get_app_state` | The window's accessibility tree as indexed lines, plus the focused element. Optional `query` filter, `include_screenshot` and `include_offscreen`. |
| `find_element` | Rank the elements matching a description without acting. Uses Jev probabilities when Jev is enabled. |
| `click` | By `element_index`, `target` or screenshot `x`/`y`. Takes `click_count`, `mouse_button`, `modifiers` and `click_method`. |
| `set_value` | Write a field, combo box or slider value directly. The result warns if the element reads back differently. |
| `type_text` | Type into the focused element, or into `element_index`/`target`. |
| `press_key` | xdotool key syntax: `Return`, `ctrl+s`, `shift+Tab`, `Page_Down`, `F5`. |
| `scroll` | Scroll an element's nearest scrollable container, or a point. `pages` can be fractional. |
| `drag` | Drag between two screenshot points. |
| `perform_secondary_action` | Expand, Collapse, Scroll Up/Down/Left/Right, Show Menu, Toggle, Select, Focus, Scroll Into View, Invoke, Read Text. |
| `perform_actions` | Run up to 50 of the steps above in order, with one result at the end. |

State lines follow Codex's grammar:

```text
Window: "OCU Fixture", App: pwsh (pid 20632, window 4851676).
2 text field (focused, settable, string) Full name, ID: fullName
5 checkbox (unchecked) Subscribe to newsletter, ID: subscribe
7 combo box (collapsed, settable, string) Plan, Value: Free, Secondary Actions: Expand, ID: plan
10 list Favourite colour, ID: colors
	11 list item Red
	13 list item Blue
18 button Submit
```

Every action tool also accepts:

- `return_state`: `diff` (the default), `full` or `none`.
- `expect`: an outcome Jev checks against the observed changes, for example "a Save As dialog opens".

## Jev targeting

The agent describes the element; open-computer-use finds it:

1. **Exact name.** If exactly one element is named what the agent wrote ("Submit",
   "Submit button"), it is used. No model is called.
2. **Jev.** One request asks a Choice over the candidates twice, in opposite orders,
   because the model favours whichever option comes first. The same request asks a Noul
   question: does the described element exist at all? The server acts only when both
   orders agree, confidence is at least 0.5 and presence is at least 0.5.
3. **Words.** Without Jev, a lexical scorer accepts only a strong, unique match.

Anything else returns a ranked shortlist and does nothing. A pick whose name contains a
destructive verb ("Delete all data", "Send", "Buy") is never acted on unless the
agent's own words include that verb.

Measured on this repo's fixture, on Windows Calculator with a Danish UI, and on Wikipedia:

| Description | Picked | Jev |
|---|---|---|
| "the button that keeps my progress without sending anything" | `Save draft` (p=1.00) | 290 ms |
| "the 7 key" / "multiply" / "equals" (Danish UI) | `Syv` / `Multiplicer med` / `Er lig med` (p=1.00) | 250–320 ms |
| "link to the article about personal computers" (about 150 candidates) | `Personal computer` (p=0.94) | 390 ms |
| "the button on the far right" | refused: it would *delete*, which the agent did not ask for | — |

Enable Jev with `--jev`, `OCU_JEV=1` or `"jev": {"enabled": true}` in the config. The API
key is read from `TYPESAFE_API_KEY`, a `jev.envFile`, `OCU_ENV_FILE` or
`JEV_9000_ENV_FILE`, so an existing JEV 9000 plugin setup works as is. Element names,
roles and the target text are sent to TypeSafe's API; screenshots never are. A call costs
a fraction of a cent (roughly $0.0001–0.0005, depending on how many candidates are sent).
See [docs/jev.md](docs/jev.md).

## Safety

- **Per-app approval.** The first use of an app asks the user through MCP elicitation:
  allow for the session, always allow, or deny. Clients that cannot ask get an error that
  tells the user how to approve: `open-computer-use approve notepad.exe`, or `approvedApps`
  in `~/.open-computer-use/config.json`. Agents have no tool to approve apps.
- **Hard blocks** that no setting overrides:
  - terminals (by window class, so GUI apps hosted by a shell still work);
  - password managers;
  - security, antivirus, sign-in and UAC prompts;
  - system administration tools;
  - AI agent apps (Claude, ChatGPT, Codex), so an agent cannot approve its own requests.
- **No Windows-key chords**, and no Ctrl+Alt+Delete.
- **The user stays in charge.** A physical Esc press stops every state-changing call for
  20 seconds. Physical keyboard or mouse-button activity makes input back off. The guard
  records timestamps only, never keys.
- **Confirmation rules** are in the server instructions: ask before sending, buying,
  deleting, changing account or security settings, or accepting agreements; never type
  passwords or payment details.

## Configuration

`~/.open-computer-use/config.json` (or `OCU_CONFIG`):

```json
{
  "approval": "prompt",
  "approvedApps": ["notepad.exe"],
  "blockedApps": [],
  "screenshots": "auto",
  "maxStateLines": 600,
  "settleMs": 200,
  "jev": { "enabled": true, "minConfidence": 0.5, "minPresence": 0.5, "maxCandidates": 120 }
}
```

Environment overrides:

| Variable | Values |
|---|---|
| `OCU_APPROVAL` | `prompt`, `allowlist`, `off` |
| `OCU_SCREENSHOTS` | `auto`, `always`, `never` |
| `OCU_JEV` | `1` or `0` |
| `OCU_JEV_MODEL` | a Jev model id |
| `OCU_WINDOWS_HELPER` | path to the helper executable |
| `OCU_GUARD` | `0` turns off the input guard |
| `OCU_STOP_LATCH_MS` | how long an Esc stop lasts |
| `OCU_USER_ACTIVE_MS` | how long input backs off after user activity |

## Development

```bash
npm run build:native
```

```bash
npm run check
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm run build:native` builds the Rust helper.
- `npm run check` type-checks the TypeScript.
- `npm test` runs the unit tests (no desktop needed).
- `npm run test:e2e` drives the WinForms fixture through a real MCP client. Set
  `OCU_E2E_JEV=1` to include Jev.

Run from source without building with `node src/cli.ts …`. [AGENTS.md](AGENTS.md) has
the contributor notes and [docs/architecture.md](docs/architecture.md) the design.

## Roadmap

- **macOS helper:** AX API, CGEvent per-pid input, ScreenCaptureKit, speaking the same
  NDJSON protocol.
- **Linux helper:** AT-SPI.
- **Browser surface over CDP:** DOM-level actions, plus tab cleanup at turn end.
- **Prebuilt helper binaries and packaging:** npm package, plus Claude Code and Codex
  plugins.
- **On-screen overlay:** shows when an agent is in control.
- **Optional code mode:** a sandboxed `js` tool, like `cua_repl`, for agents that batch
  better in code.

## Credits

The design draws on public documentation and on studies of
[openai/codex](https://github.com/openai/codex),
[ifuryst/open-codex-computer-use](https://github.com/ifuryst/open-codex-computer-use) and
[amontlabs/lcu](https://github.com/amontlabs/lcu). See [docs/research.md](docs/research.md).

## License

MIT
