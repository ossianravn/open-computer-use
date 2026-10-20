# Working on open-cu

An MCP server and CLI (TypeScript, `src/`) over a native platform helper (Rust in
`native/windows/`, Swift in `native/macos/`). Read [docs/architecture.md](docs/architecture.md)
before changing the helper protocol, the state model or the rendering.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies. |
| `npm run build:native` | Build the host helper: Windows Rust or macOS universal Swift binary. |
| `npm run build:js` | Bundle `dist/cli.mjs`. |
| `npm run check` | Type-check (TypeScript 7). |
| `npm test` | Unit tests; no desktop needed. |
| `npm run test:e2e` | Drives the host fixture through a real MCP client (Windows or macOS). `OCU_E2E_JEV=1` adds Jev cases. |
| `cargo test --manifest-path native/windows/Cargo.toml` | Rust unit tests. |
| `node src/cli.ts <command>` | Run from source; Node 22.18+ strips types. |

Installed MCP servers run `dist/cli.mjs` and the host helper (`ocu-win.exe` or
`native/macos/bin/ocu-mac`). After
changing `src/`, run `npm run build:js`; new agent sessions pick it up. A running
session keeps `ocu-win.exe` open, so `npm run build:native` cannot replace it until
those sessions end (or point `OCU_WINDOWS_HELPER` at another build).

## Packaging and releases

The repository is the plugin: GitHub installs in every client copy it as is.

- **Shipped files:** `dist/cli.mjs` (all JS dependencies bundled),
  `native/windows/bin/ocu-win.exe`, and `native/macos/bin/ocu-mac` are committed. Rebuild
  whichever one your change affects, then run `npm run validate` before committing. It fails when an artifact is
  older than its sources or when versions disagree.
- **Manifests:**
  - portable `plugin.json` + `mcp.json` + `skills/` (Codex reads these);
  - `.claude-plugin/plugin.json` (inline MCP server) and `.claude-plugin/marketplace.json`;
  - `.agents/plugins/marketplace.json` (Codex);
  - `index.js` → `opencode/index.mjs` (OpenCode v2).
- **One version** in `package.json`, both `plugin.json` files and `VERSION` in
  `src/server.ts`.
- **No script named `build` or `prepare`:** npm would prepare Git installs and fail.
- **Verify installs** in isolated profiles:
  - `CLAUDE_CONFIG_DIR`;
  - `CODEX_HOME`;
  - OpenCode `XDG_*` folders plus `opencode service set port <port>`.

  Then run `node scripts/check-installed.mjs <installed dist/cli.mjs>`, and record the
  results in `docs/compatibility.md`.

Write TypeScript as erasable syntax only (no enums, namespaces or parameter
properties), because Node runs the sources directly. Use `.ts` extensions in imports.

## Testing against real apps

- Use the fixture `fixtures/windows/fixture.ps1` (a WinForms form) for anything that
  clicks or types. Start it with an argument array (Node `spawn`) so a title with spaces
  stays intact. `Start-Process -WindowStyle Hidden` hides the form itself.
- Do not drive the user's own windows (their browser profile, editors, mail) in tests.
  For web content, start a separate Chrome with a throwaway `--user-data-dir` and
  address it by window id.
- Use a scratch config (`OCU_CONFIG=<temp>/config.json` with `{"approval":"all"}`) so
  tests never write to `~/.open-cu`.
- On macOS, use the disposable AppKit fixture (`fixtures/macos/main.swift`) via
  `tests/e2e/macos.test.ts`. It compiles into a temporary app bundle and cleans up
  its own process and files. Live tests require Accessibility, Screen Recording and
  a working Esc guard; a missing permission is a failure, not a passing skip.
- Calculator is a safe UWP target (`launch_app "Calculator"`); its labels follow the OS
  language.

## Conventions

- **Tool results are written for the model.** Say what happened and what to do next.
  `ToolError` codes are stable identifiers; messages can change.
- **Report how an action was delivered** (UI Automation pattern vs. physical input).
  Never fall back silently to a riskier method.
- **Changing the rendered text grammar** (`view.ts`) changes what agents read. Keep it
  Codex-compatible and update `tests/unit/view.test.ts`.
- **Safety:**
  - Hard blocks live in `src/policy.ts`, and no config can lift them.
  - Never add a tool that approves apps.
  - The helper's input guard stores timestamps only.
- **Jev is optional.** Every path must work without a key, and a Jev failure falls back
  to lexical matching with a note.
- **Keep stdout clean in the MCP server.** Logs go to stderr.
