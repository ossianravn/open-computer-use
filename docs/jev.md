# Jev targeting

Most of an agent's computer-use time goes into reading. To click "Save", it fetches a
tree that can run to thousands of tokens, finds the right line, and then makes another
call. TypeSafe's [Jev](https://docs.typesafe.ai) is a "System One" model: it returns
typed judgments with probabilities in a few hundred milliseconds. open-computer-use uses
it to resolve a description to an element on the server side, so the agent can act in
one call:

```text
click(app: "OCU Fixture", target: "the button that keeps my progress without sending anything",
      expect: "the status says the draft was saved")

Target "…" → 17 button Save draft (Jev, confidence 1.00, presence 0.98, 288 ms).
Clicked 17 Save draft via UI Automation (invoke).
Changes (+ added, - removed, ~ changed):
~ 16 text Status: draft saved, ID: status
Expectation "the status says the draft was saved": likely met (Jev p=0.91, 214 ms).
```

Jev is optional and off by default. Without it, `target` still works for clear name
matches.

## Resolution pipeline

`resolveTarget` in `src/jev.ts`:

1. **Candidates.** Lines of the current view that support the purpose:
   - click: invoke, toggle, select, expand, a default action, focusable elements, links,
     named text;
   - `set_value`: settable elements;
   - scroll: scrollable elements;
   - and so on.

   Links written inline in text lines count too. Each candidate carries its rendered
   line, up to three named ancestors as context, and a position in words ("bottom
   right"). Jev handles numbers poorly, so there are no coordinates.
2. **Exact name.** If exactly one candidate's name equals the target (trailing role words
   such as "button" or "field" are ignored), it is used. No model call.
3. **Jev**, if enabled and configured. The shortlist is every lexical hit plus the rest in
   tree order, up to `maxCandidates` (120; the API allows 255). One request asks three
   questions over shared state:
   - `forward`: a Choice over the element ids in tree order, plus `none`;
   - `reverse`: the same Choice with the ids reversed (jev-1.13 favours the first
     option);
   - `present`: a Noul, "Does `elements` contain the UI element that `target`
     describes?"

   **Decision:**
   - Act only if both orders pick the same element, the weaker confidence is at least
     `minConfidence` (0.5), and presence is at least `minPresence` (0.5).
   - Both orders answering `none`, or presence below half of `minPresence`, means the
     element is absent.
   - Anything else is ambiguous; candidates are ranked by the average of the two
     distributions.
4. **Lexical fallback.** Used when Jev is off, unconfigured or unreachable. It scores name
   words, value, automation id, help text, context and role words. It accepts only a
   strong match (≥ 4) that leads the runner-up by 1.6×.
5. **Destructive guard.** A pick whose name contains a destructive verb (delete, remove,
   send, submit, pay, buy, order, confirm, reset, sign out, …) is downgraded to ambiguous
   unless the target itself uses that verb. Element text is untrusted, and a judgment
   alone never authorizes an irreversible action.

When nothing qualifies, the tool fails with `target_ambiguous` or `target_not_found`,
lists the best candidates with their indices (and probabilities), and does nothing.

## Outcome checks

When an action carries `expect` and Jev is ready, the server sends the observed diff
(added, removed and changed lines, capped at 60 each), new windows and the focused
element. It asks one Noul: "After `action`, do `changes` and `focused` show that
`expected` happened?" The result reads `likely met` (p ≥ 0.75), `likely NOT met`
(p ≤ 0.25) or `unclear`. This replaces another `get_app_state` round trip when the
agent only needs a yes or no.

## Results so far

| Case | Result |
|---|---|
| Paraphrase on a form: "button that keeps my progress without sending anything" | `Save draft`, p=1.00, 290 ms |
| English targets on a Danish Calculator: "the 7 key", "multiply", "the 6 key", "equals" | 4/4 correct, confidence 1.00, 250–320 ms each; `expect: "the display shows 42"` → p=0.96 |
| Wikipedia, about 150 candidates: "link to the article about personal computers" | `Personal computer`, p=0.94 (runner-up: the second link to the same article), 390 ms |
| "the colour of a clear sky" (Blue vs. its list) | orders disagreed, so nothing was done |
| "the button on the far right" (Delete all data) | refused by the destructive guard |

These are spot checks, not a benchmark. The thresholds are starting points and should be
tuned on labelled traces from real use.

## Setup

1. **Get a key** at <https://console.typesafe.ai/keys>.
2. **Make it available.** Put it in `TYPESAFE_API_KEY`, or in a `.env` file referenced by
   `jev.envFile`, `OCU_ENV_FILE` or `JEV_9000_ENV_FILE`. The JEV 9000 plugin's file works
   as is.
3. **Turn Jev on** with `--jev`, `OCU_JEV=1` or `"jev": {"enabled": true}`.
4. **Check it.** `open-computer-use doctor --jev` prints `Jev: ready (model …)`.

Settings, under `jev` in the config:

| Setting | Default | Meaning |
|---|---|---|
| `model` | `jev-latest` | Pin a version (e.g. `jev-1.13.0`) for stable behaviour. |
| `minConfidence` | 0.5 | Weaker of the two Choice confidences needed to act. |
| `minPresence` | 0.5 | Probability that the element exists needed to act. |
| `maxCandidates` | 120 | Options per Choice. |
| `timeoutMs` | 4000 | Per request; one retry. |

## Privacy and cost

- **What is sent:** the app and window name, the agent's target text and candidate
  element lines (role, name, value, states, context) go to `api.typesafe.ai`.
  Screenshots are never sent.
- **When nothing is sent:** with Jev disabled, nothing leaves the machine. The exact-name
  fast path also sends nothing.
- **Cost:** about $0.04 per million input tokens, and output is free. A typical
  resolution is 1–8k input tokens, a fraction of a cent.
- **Logs:** SDK logging goes to stderr only, so it never mixes into the MCP stream.
