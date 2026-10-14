# Architecture

```text
 agent (Claude Code, Codex, Cursor, …)          shell-only agent
        │ MCP over stdio                              │ argv / stdout
        ▼                                             ▼
 ┌──────────────────────── Node (src/) ─────────────────────────┐
 │ server.ts (MCP tools)         cli.ts (same tools, CLI)       │
 │                  └──────► computer.ts ◄──────┘               │
 │  apps.ts      resolve app/window → one window                │
 │  policy.ts    hard blocks, key rules, per-app approval       │
 │  state.ts     snapshot → stable element indices              │
 │  view.ts      tree → Codex-style lines, query, diff          │
 │  targets.ts   candidates + lexical scoring                   │
 │  jev.ts       optional TypeSafe Jev resolution/verification  │
 │  helper.ts    NDJSON client, restarts the helper on failure  │
 └───────────────────────────┬──────────────────────────────────┘
                             │ NDJSON over stdio
                             ▼
 ┌──────────── ocu-win.exe (native/windows, Rust) ──────────────┐
 │ uia.rs        UI Automation snapshots and pattern actions    │
 │ input.rs      SendInput mouse/keyboard, occlusion check      │
 │ capture.rs    PrintWindow capture, DPI correction, JPEG/PNG  │
 │ guard.rs      low-level hooks: Esc stop, user-activity back-off │
 │ overlay.rs    blue screen-edge glow + "open-cu is using …" label │
 │ windows_enum.rs  window inventory, activation                │
 └──────────────────────────────────────────────────────────────┘
```

Everything above the helper is platform-neutral. A macOS or Linux port is a new helper
that speaks the same protocol, plus a `Platform` entry in `src/platform.ts` for app
launching and the installed-app list.

## Helper protocol

One JSON object per line in each direction:

```text
→ {"id": 7, "method": "snapshot", "params": {"hwnd": 4851676}}
← {"id": 7, "result": {"snapshotId": 12, "window": {…}, "nodes": [...], "truncated": false, "elapsedMs": 47}}
← {"id": 8, "error": {"code": "element_unavailable", "message": "…"}}
```

| Method | Purpose |
|---|---|
| `ping` | Version and platform. |
| `listWindows {includeAll?}` | Top-level windows: title, class, pid, process, frame, minimized/enabled/foreground, owner, `appWindow`, DPI. UWP frames report the hosted app's process. |
| `snapshot {hwnd, includeOffscreen?, raw?, maxNodes?, maxDepth?}` | Depth-first nodes with role, name, value, automation id, rect, states, available actions and UIA runtime id. The helper keeps live element references for the latest snapshot of each window. |
| `elementAction {hwnd, elementId, snapshotId?, action, …}` | `invoke`, `toggle`, `select`, `expand`, `collapse`, `setValue` (reads the value back), `focus`, `scroll`, `scrollIntoView`, `defaultAction`, `showContextMenu`, `readText`. Runs on a worker thread; reports `pending` instead of blocking when an app holds the call open (a modal dialog). |
| `elementInfo`, `elementAtPoint`, `focusedElement` | Fresh geometry and state for physical input and diagnostics. |
| `activateWindow`, `click`, `moveMouse`, `drag`, `scroll`, `typeText`, `pressKey` | Physical input. With `hwnd`, the window is brought to the front and the point must belong to its process. |
| `screenshot {hwnd?, maxEdge?, format?, quality?}` | Base64 image plus `origin` and `scale` (screen = origin + image × scale). |
| `guardStatus`, `clearStop` | The physical-input guard. |

Error codes are stable strings (`element_unavailable`, `stale_snapshot`, `window_gone`,
`point_occluded`, `input_blocked`, `stopped_by_user`, `user_active`, `timeout`, …) and
messages are written for the model.

### Why these Windows choices

- **One cached subtree request per snapshot.** `ElementFromHandleBuildCache` with
  `TreeScope_Subtree` fetches every property in one cross-process round trip. The
  default view also filters `IsOffscreen = false` inside the request, so providers like
  Chromium skip serializing off-screen content (583 ms → 145 ms on a long article).
- **Patterns before pixels.** Invoke, Toggle, SelectionItem, ExpandCollapse and Value
  work on background windows and never touch the pointer.
- **`PrintWindow(PW_RENDERFULLCONTENT)`.** It captures the window's own pixels, so
  overlapping windows never leak in. For windows that are not DPI-aware, the crop is
  measured in the window's own scale and the returned `scale` maps back to screen pixels.
- **Per-monitor DPI awareness** for the helper process, so UIA rectangles, window rects,
  `SendInput` and screenshots share one physical-pixel space.
- **Transaction timeouts and worker threads.** A hung app costs at most a timeout; the
  Node side restarts the helper if it stops answering.

## State model

`WindowState` holds the latest snapshot of one window. Each element gets an **index**
from `IdentityMap`, keyed by its UIA runtime id (or its path when the provider gives
none). An element keeps its index across refreshes for as long as it exists; new
elements get new numbers. Because of this:

- an index the agent read three actions ago still works if the element is still there;
- a diff after an action is just the elements that really changed;
- the CLI can persist identities in a temp file, so indices survive between invocations.

The helper addresses elements by position in its latest snapshot. `WindowState.helperIds`
maps stable indices to those positions. When the helper reports an element as
unavailable, the server refreshes once and retries if the same identity is still there.

## Rendering (`view.ts`)

The tree becomes Codex-style lines:

```text
<index> <role> (<states>) <name>, Value: …, Description: …, Shortcut: …, Secondary Actions: …, ID: …
```

These transforms remove structural noise without hiding anything actionable:

| Transform | Example |
|---|---|
| Drop chrome and invisible elements | Title bars (including UWP and WinUI ones drawn as windows), scroll bars, separators, zero-size unnamed leaves. |
| Hoist unnamed wrappers | An unnamed `Pane` or `Group` with no actions disappears; its children move up. |
| Drop echo labels | `text Full name` before `text field Full name`; a combo box's own name repeated in its text child. |
| Merge text runs and inline links | Web paragraphs split into many nodes become one line: `86 text … see [Personal computer](#87).` Inline links remain clickable by index and are candidates for `target`. |
| Shorten | Field values to 200 characters, link URLs to 100. Generated ids (`view_1012`, `mwKQ`, `button1`) are hidden. |

`renderView` adds the header, an optional `query` filter (matching lines plus their
ancestors), an explicit marker when lines are cut, and the focused element. `diffViews`
compares two views by index and ignores pure focus moves; the focused element is
reported on its own line instead. When more than 60 lines, or 60% of the view, change,
an action returns the full state instead of the diff.

## Actions (`computer.ts`)

Every action follows the same steps:

1. Resolve the window (`apps.ts`). A main window disabled by a modal dialog redirects
   to the dialog, with a note.
2. Check the hard blocks, then approval.
3. Refresh the state if it is more than 1.5 s old.
4. Pick the element: `element_index`, or `target` through the resolver, or screenshot
   coordinates mapped through the last capture (refused without a screenshot, or if the
   window was resized since).
5. Deliver the action. For clicks the order is: select (list, tree and tab items, radio
   buttons) → toggle → invoke → expand/collapse → legacy default action → focus (text
   fields) → physical click at the clickable point.
6. Wait `settleMs`, then report the delivery method, the diff, new windows of the app
   (dialogs), focus changes and, with `expect` and Jev, a verdict.

`perform_actions` runs steps against the already-approved window with a short settle
between steps, and returns one diff against the state before the batch.

## Overlay

While an agent uses an app, the helper shows a blue glow around the edges of that
window's monitor, plus a label at the top centre: "open-cu is using *App* · Esc to
stop". This is the open counterpart of the Codex Computer Use overlay.

- **Trigger.** The server sends `overlayShow { hwnd, label, idleMs }` whenever a tool
  resolves an app window (after the policy and approval checks). Every action inside
  `perform_actions` sends it too.
- **Lifetime.** It fades in over 180 ms and breathes gently while active (unless Windows
  animations are off). After `idleMs` without activity (15 s by default) it fades out.
  A physical Esc press hides it at once.
- **Windows.** Five layered popups on their own message-loop thread: four edge strips
  and the label. Small strips keep per-pixel-alpha bitmaps cheap even on 4K monitors.
  Breathing changes only each window's constant alpha.
- **Never in the way.**
  - The windows are `WS_EX_TRANSPARENT` (click-through), `WS_EX_NOACTIVATE` and
    topmost, and they hit-test transparent.
  - They are excluded from screen capture (`WDA_EXCLUDEFROMCAPTURE`), so the agent's
    screenshots never contain them.
  - The helper leaves its own windows out of `listWindows` and the occlusion check.
  - `OCU_OVERLAY_CAPTURE=1` makes them capturable, for documentation screenshots.
- **Off switch.** `"overlay": false` in the config, or `OCU_OVERLAY=0`.

## Typing

`typeText` types the way a keyboard does, because some apps get synthetic input wrong.
WinUI apps such as Windows 11 Notepad work out a key's character from the keyboard
state at the moment they process it, not when it was sent. Measured failures with plain
bursts:

- Unicode packets: "abc" arrived as "ccc".
- Shift and AltGr released early: "Æ" became "æ", "@" became "2".
- Keys arriving faster than the app keeps up were dropped.

The helper therefore:

1. Maps each character through the target window's keyboard layout to a real key plus
   Shift or AltGr (the right Alt key, not Ctrl+Alt). Unicode packets are used only for
   characters the layout cannot type (emoji, dead-key characters such as ^ ´ ~, other
   scripts).
2. Groups characters by the modifiers they need. It holds those modifiers for the whole
   group, and before changing them waits until the focused element's text shows the
   group has landed.
3. Sends one key at a time, a few milliseconds apart. After each key it waits for the
   window's thread to handle a `WM_NULL` sent message, which bounds how far the app
   can fall behind without polling the text.

On the hard case (`Ærø & Østerbro, @{}[]$€ "q" 50% ~^´ é ü — 🙂`), this went from
garbled to exact in every run. `type_text` reports characters the text did not confirm
in time.

## Policy (`policy.ts`)

- **Hard blocks:** terminals (process names and console window classes), password
  managers, security and system administration tools, sign-in and UAC prompts, and AI
  agent apps unless `allowAgentApps` is set.
- **Keys:** no Windows-key chords and no Ctrl+Alt+Delete.
- **Approval:**
  - `all` (the default): every app is allowed, so agents are never stopped midway.
    `off` is an accepted older name.
  - `prompt`: MCP elicitation where the client supports it. An explicit **Deny** is a
    refusal; a prompt the client closes or cannot show is reported as such, not as a
    refusal.
  - `allowlist`: only listed apps.

  "Always" answers are written to the config file. Approval settings are re-read from
  disk when an app is not yet approved, so `open-cu approve` and `open-cu approval`
  apply without a restart. There is no tool for approving apps.
- **Input guard (helper):** physical Esc latches a stop (20 s by default). Physical key
  or mouse-button activity within 700 ms makes physical input fail with `user_active`.
  The server waits and retries for about 5 s before passing that on, so a user typing
  elsewhere only delays the agent. Synthetic input carries the injected flag and is
  ignored.
