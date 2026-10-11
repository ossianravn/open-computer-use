# Working on open-cu

An MCP server and CLI (TypeScript, `src/`) over a native platform helper (Rust,
`native/windows/`). Read [docs/architecture.md](docs/architecture.md) before changing the
helper protocol, the state model or the rendering.

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies. |
| `npm run build:native` | Build `ocu-win.exe` and copy it to `native/windows/bin/`. |
| `npm run build:js` | Bundle `dist/cli.mjs`. |
| `npm run check` | Type-check (TypeScript 7). |
| `npm test` | Unit tests; no desktop needed. |
| `npm run test:e2e` | Drives the fixture through a real MCP client (Windows). `OCU_E2E_JEV=1` adds Jev cases. |
| `cargo test --manifest-path native/windows/Cargo.toml` | Rust unit tests. |
| `node src/cli.ts <command>` | Run from source; Node 22.18+ strips types. |

Installed MCP servers run `dist/cli.mjs` and `native/windows/bin/ocu-win.exe`. After
changing `src/`, run `npm run build:js`; new agent sessions pick it up. A running
session keeps `ocu-win.exe` open, so `npm run build:native` cannot replace it until
those sessions end (or point `OCU_WINDOWS_HELPER` at another build).

Write TypeScript as erasable syntax only (no enums, namespaces or parameter
properties), because Node runs the sources directly. Use `.ts` extensions in imports.

## Testing against real apps

- Use the fixture `fixtures/windows/fixture.ps1` (a WinForms form) for anything that
  clicks or types. Start it with an argument array (Node `spawn`) so a title with spaces
  stays intact. `Start-Process -WindowStyle Hidden` hides the form itself.
- Do not drive the user's own windows (their browser profile, editors, mail) in tests.
  For web content, start a separate Chrome with a throwaway `--user-data-dir` and
  address it by window id.
- Use a scratch config (`OCU_CONFIG=<temp>/config.json` with `{"approval":"off"}`) so
  tests never write to `~/.open-cu`.
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
