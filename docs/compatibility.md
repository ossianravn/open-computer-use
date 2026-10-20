# Compatibility record

What has actually been exercised, on which versions, and what has not. Update this when a
host, runtime or install path changes.

## Installation from GitHub (11 October 2026)

All checks ran on Windows 11 Pro 10.0.26200 (x64) with Node 24.19.0 and npm 11.17.0,
installing commit `d5d6525` from `github.com/ossianravn/open-computer-use` (private;
Git credentials with access). Each client used an isolated profile, so the user's own
configuration was not touched:

| Client | Profile isolation |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` |
| Codex | `CODEX_HOME` |
| OpenCode | `XDG_*` folders and its own service port (4199) |
| npx and npm | a private cache and prefix |

After installing, `scripts/check-installed.mjs` connected to the **installed** copy over
MCP stdio. For every route it listed all 12 tools and ran the read-only `list_apps`
against the live helper.

| Route | Version | Commands | Result |
|---|---|---|---|
| Claude Code | 2.1.288 | `claude plugin marketplace add ossianravn/open-computer-use`, `claude plugin install open-cu@open-cu` | Installed (user scope). `claude mcp list` showed `plugin:open-cu:open-cu … Connected`. `claude plugin details` found skill `open-cu` and MCP server `open-cu`. Installed-server check passed. |
| Codex CLI | 0.160.0 | `codex plugin marketplace add ossianravn/open-computer-use`, `codex plugin add open-cu@open-cu` | Installed and enabled. `codex mcp list` showed `open-cu` with `PLUGIN_ROOT` resolved. The skill file is present in the installed plugin. Installed-server check passed. |
| OpenCode | 2.0.18 | `opencode plugin add github:ossianravn/open-computer-use`, then `opencode service restart` | Added to the profile's `opencode.json`. Plugins load only after the background service restarts. Then `opencode mcp list` showed `✓ open-cu connected`, and the server's skill list contains `open-cu`. Installed-server check passed. |
| npx (any MCP client) | npm 11.17.0 | `npx --yes github:ossianravn/open-computer-use doctor` | Fetched and ran in about 11 s with a cold cache. Installed-server check passed. |
| npm global | npm 11.17.0 | `npm install -g github:ossianravn/open-computer-use` | `open-cu` command installed (7.6 s); `--help` and `approval` ran. |

Manifests: `claude plugin validate` passed for `.claude-plugin/marketplace.json`, both
default and `--strict`. For `.claude-plugin/plugin.json` it passed, but `--strict`
flagged one warning: the repository's contributor `CLAUDE.md` is not loaded as plugin
context, which is expected. `npm run validate` checks versions, names, the skill
frontmatter and artifact freshness. `npm pack --dry-run` lists 13 files: the bundle,
helper, adapter, manifests, skill, docs, license and readme.

## Not yet exercised

- **Codex desktop:** the **Plugins** panel install controls. The CLI path above was
  checked.
- **Claude Desktop:** the plugin browser in the **Code** tab. The CLI path, which
  shares user-scope installs, was checked.
- **Approval dialog:** Claude Code 2.1.288 and OpenCode 2.0.18 advertise MCP
  elicitation to the server (recorded by `open-cu doctor`). The approval dialog itself
  was exercised only with an SDK test client.
- **Approval prompts can be cancelled unseen.** Observed 14 October 2026: Claude Code
  2.1.299 advertises MCP elicitation, yet in a Claude Desktop **Code** tab session it
  cancelled open-cu's approval prompt without showing it. Version 0.2.0 reported that
  cancellation as "the user declined" and blocked the agent. Since 0.2.1, approval
  defaults to `all`, and a cancelled prompt is no longer treated as a refusal.
- **Linux:** the server starts, but desktop tools report that no Linux helper exists.
  The macOS implementation and its verification are recorded below.
- **Code signing:** the prebuilt `ocu-win.exe` is unsigned. Security software that
  dislikes unsigned programs with keyboard hooks may flag it; rebuilding from source
  with `npm run build:native` produces the same program.

## Functional evidence

Same date and machine:

- **Unit tests:** 20 pass (`npm test`).
- **End-to-end:** 8 pass (`npm run test:e2e`, with `OCU_E2E_JEV=1`). They drive the
  WinForms fixture through a real MCP client: the approval prompt, form filling, a
  batch, typing Shift/AltGr/accented/emoji text, stable indices, coordinate guards,
  ambiguity handling and Jev resolution.
- **Live apps:**
  - Windows Calculator (UWP, Danish UI) with English Jev targets.
  - Windows 11 Notepad (WinUI): typing, saving, and the save-format dialog.
  - Chrome with a throwaway profile on Wikipedia: snapshots, inline links, scrolling
    and Jev targets.

- **Overlay** (same machine, 3455×2040 monitor at 250% scaling):
  - The glow and label render.
  - A hit-test under the label lands on the app beneath.
  - The overlay's windows are not listed as apps.
  - It fades out after its idle time.
  - With default settings it is absent from screen capture.

See [architecture.md](architecture.md#typing) for the typing behaviour found in Notepad.

## macOS port (20 October 2026)

Host: macOS 26.6 (25G72), Apple silicon, Node 24.15.0. The helper targets macOS 14+
and is built as a universal arm64/x86_64 executable with the installed Xcode Swift
compiler. `lipo -archs` confirms both slices; `codesign --verify` accepts its ad-hoc
signature. Neither a compiler nor npm dependency installation is needed by a
packaged MCP consumer.

Final checks: `npm run check` passes; all **28 unit tests** pass; `npm run test:e2e`
passes **9 macOS cases** and skips the 8 Windows cases on this host.
`npm run validate`, `git diff --check`, universal-architecture inspection and
code-signature verification pass.

The live MCP suite uses only a temporary AppKit fixture bundle and a scratch
`OCU_CONFIG`; teardown terminates its process and removes its files. It covers
window discovery, installed-app discovery and launch, AX form actions and batches,
Unicode typing, Command shortcuts, stable indices, stale snapshots, secondary text
reads, helper-restart identities, screenshots, coordinate conversion, physical clicking/dragging, resize
rejection, numeric and pop-up controls, scrolling, physical sheet controls, the overlay, and a simulated
foreign Escape that latches the guard and blocks further actions. No user-owned
app receives test input.

Packaging is checked with `npm pack`, installation of that tarball into a temporary
npm prefix, and `scripts/check-installed.mjs` against the installed bundled CLI.
The installed server exposes all 12 tools and successfully runs `list_apps`; its
`doctor` identifies `ocu-mac` and reports working permissions and input guard.
A separate restricted run confirms missing Accessibility and Screen Recording
produce explicit errors rather than silent success.

Remaining coverage limits:

- Intel and macOS 14 are build targets, not live-tested hosts in this run.
- The eight Windows E2E cases skip on macOS; Windows source and its shipped binary
  are unchanged. Cross-platform unit tests and TypeScript checks run on macOS.
- Jev is off; no external model or paid service is needed by the macOS suite.
- Browser content, multiple displays, Spaces/fullscreen transitions, and the visual
  rendering of the overlay have not been separately validated on macOS.
- Claude/Codex/OpenCode-specific installer flows retain their existing manifests;
  the fresh macOS install check exercises the npm package and real MCP stdio path.
- The macOS helper is ad-hoc signed, without Developer ID signing or notarization.
  Gatekeeper handling of browser-downloaded archives is not tested.

The artifact validator also handles fresh-checkout timestamps: an unchanged binary
is accepted only when its last committed version contains the current source tree.
Dirty, untracked, or subsequently committed source changes still require rebuilding.
A regression test covers those cases, so macOS validation does not require rebuilding
the untouched Windows helper.
