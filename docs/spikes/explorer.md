# Spike: exploration agent, recorded flows and replay (Oct 28)

Machine: Apple M2, 8 GB RAM, Xcode 27.1, simulator "Shotwright iPhone 6.9" (iPhone 17 Pro Max,
iOS 27.0). Demo app: Renew (subscription tracker, the developer's own app), built from a copy
in the session scratchpad. All captures are in the scratchpad, not in the repo.

## Summary

| Question | Result |
|---|---|
| Does the agent find marketable screens on its own? | **Yes.** Every model found the same core four within 8 turns: Home overview, Calendar, Insights donut chart, a subscription detail. Then it added 2–3 more (Insights cards, All list, trial and split-cost details). Only hint given: "A subscription tracker." |
| Is the recorded flow short? | **Yes.** 10–16 actions while exploring became 7–12 actions in the flow (shortest known path to each marked screen), with no relaunches. |
| Does the flow replay in other languages? | **Yes, every screenshot verified in en, de and ja** for the final flows of all three models (6–7 screens each, 26–45 s per locale). `-AppleLanguages` / `-AppleLocale` are enough for Renew; add `-sampleRegion DE/JP` for local prices. |
| Spark 1.3 vs Wonder vs Spark Open | Pick quality is about the same. **Spark 1.3 is the default**: $0.04–0.06 per exploration, about 2 s per turn. Wonder needs the fewest turns (13, because it marks and acts in the same turn) but costs 2.5–3.5x more ($0.13). Spark Open is free on Baseten and just as good, but about 2x slower per turn (4.3 s). |
| Screen judge (Spark Open) | Works with structured output. 13–25 s for 6–7 screens. The ranking is consistent across runs: Home, then Insights and Calendar in some order, then detail screens last, flagged as near-duplicates. Captions are usable, e.g. "Never miss a renewal date". |
| Cost | **$0.35 in total on the Meta Model API** for 5 explorations plus probes (budget $5). Baseten: about 230 k input and 50 k output tokens, $0 (list price about $0.25). |

Two replay failures found and fixed along the way: a list row hidden under the floating tab bar,
and a graph shortcut that missed hidden app state. Both are under "Problems" below.

---

## How it works

```
explore()                                     replayFlow()
  launch (simctl) ─► observe ─► model turn      launch with locale args
        ▲                         │             for each step: resolve selector in a fresh
        │      run step via the same executors  snapshot, scroll into view, tap / swipe / type
        └──── record transition ◄─┘             waitFor anchor, screenshot, verify
  done ─► FlowRecorder.build() ─► verify replay ─► literal-path repair ─► flow.json
```

### Runner module (`packages/agent/src/runner/`)

- `ensureRunner({ udid })` boots the simulator if needed. It builds `ios/ShotwrightRunner` once
  per Xcode version and runner source hash (cache: `~/Library/Caches/Shotwright/runner/xcode-27.1-27A9275/`,
  stamp file `shotwright-runner.json`). Then it starts `xcodebuild test-without-building` in the
  background and waits for `/health`. Several calls for the same udid and port share one runner.
- `RunnerDriver implements DeviceDriver` over the runner's HTTP API:
  - **Timeouts.** Every request has its own timeout. When a request times out, the driver polls
    `/health` for up to 15 s. If the runner stays silent, it is hung: the driver kills
    xcodebuild and the listener and starts a new runner. Idempotent reads are then retried once;
    actions throw `RunnerRestartedError`. Verified by freezing the runner with `SIGSTOP`: detected
    in about 10 s, restarted in 5–6 s, the retried `/source` succeeded, and a `/tap` threw
    `RunnerRestartedError`.
  - **Launch.** `launch()` presses Home (no "◀ App" back-link), then calls `simctl launch` (fails
    fast, safe right after an install). It then waits until two `/source` snapshots have the
    same layout for at least 1.5 s.
  - **Settling.** After every tap, swipe or type, the driver waits for a stable layout.
  - **Swipes.** All swipes are coordinate drags with a 0.2 s hold, so momentum never scrolls
    further than the finger moved. Direction swipes become centred drags over half the screen
    (or the `within` element).
- On process exit, the module kills any runner it spawned.

### Observation (`packages/explorer/src/observe.ts`)

Each step, the model gets:

- **A screenshot** downscaled to point size (440×956 JPEG, about 40 KB). On Muse Spark 1.3 that
  is **562 tokens**, measured with `/responses/input_tokens`. Other sizes: 330×717 is 314 tokens,
  660×1434 is 1,250 and the full 1320×2868 is 4,098.
- **A compact element list**, one line per useful visible element:

  ```
  Screen 0: 18 elements, title "Home", tab "Home" selected.
  e2 button "Settings" (95,88) in:navigationBar
  e10 button "Netflix, $15.49, Monthly, ••4242, Renews Today, Oct 28, Due today" (500,489)
  e19 button "Calendar" #calendar (500,946) in:tabBar
  ```

  Each line has a ref, type, label, `#identifier` and centre on a 0–1000 grid. The filter keeps
  elements that are interactive, have an identifier, or are texts that add information. It drops
  texts and images inside a kept button, keyboard keys, punctuation-only texts and elements
  covered by the tab bar or navigation bar. Renew's Home screen goes from 205 nodes to 18 lines.

From the same data the explorer computes:

- a **fingerprint** (a hash of type, identifier, label and the selected flag, plus the value of
  switches and fields) to recognise screens again;
- **stable identifiers**: visible identifiers, minus navigation-bar ids (UIKit uses the localized
  title) and ids that equal a label;
- a **structure signature**: the type sequence of the element list, which does not depend on
  the language.

### Tools (`tools.ts`)

| Tool | Notes |
|---|---|
| `tap(element_id)` | Preferred. Recorded as a selector, with a normalized fallback point at the element's centre. |
| `tap_at(x, y)` | 0–1000 grid. Recorded against the smallest labelled element under the point. |
| `swipe(direction \| from/to, element_id?, distance?)` | `direction` is the finger movement. A from/to swipe is converted to a flow swipe (direction, distance, target) first, then run, so exploration and replay do the same thing. |
| `type_text(text, element_id?)` | |
| `relaunch()` | |
| `mark_screen(name, why, marketing_score)` | Can be sent with one action in the same turn; it applies to the screen before the action. |
| `done(ranked, notes)` | |

- `tool_choice` is `"auto"` and `parallel_tool_calls` is `true`. In one turn the explorer runs
  every mark first, then at most one action, then `done`.
- A plain-text reply gets a nudge ("Answer with a tool call…"). Four in a row end the run.
  Spark 1.3 sent one text reply in two of its runs; the nudge always worked.
- Invalid arguments come back to the model as error text.

### Providers (`providers/`)

- **`MuseResponsesProvider`** (`muse-spark-1.3`, `muse-wonder-1.0`): Responses API with our
  function tools and `store: false`. The full conversation is sent every turn, but only the
  newest observation carries the screenshot and element list; older ones collapse to one line.
  That keeps the prefix stable: 62–81 % of input tokens were cached. Function calls are replayed
  without `id`; assistant text next to a call is logged, not replayed; reasoning items are dropped.
- **`ChatProvider`** (Muse Spark Open on Baseten, `meta-models/muse-spark-open-1026`):
  - Chat Completions. **Spark Open supports native tool calls on Baseten**, and also
    `response_format: json_schema`, which the judge uses.
  - Tool messages carry text only, so the newest screenshot goes in a user message right after
    the tool results.
  - Responses include `reasoning_content`; it is logged.
  - `mode: "json"` (`--model open-json`) is the fallback for endpoints without tools: the tools
    are described in the system prompt and the model answers with
    `{"tool": ..., "args": {...}}`. Tested for 12 turns: every reply parsed.
- The explorer depends only on the `ExplorerProvider` interface and `DeviceDriver`. It works on
  the Mac (RunnerDriver) and would work on the server (the WebSocket driver) unchanged.

### Recording a short flow (`recorder.ts`)

- Every executed action is an edge between two fingerprints. A (re)launch is an edge from START.
- Screens whose element lines overlap by at least 90 % are one node for path finding. For
  example, the same list after a round trip can differ in one label.
- At the end, the flow visits the marked screens in the order they were marked. For each one it
  takes the cheapest known path (Dijkstra): from the previous marked screen, or from a relaunch
  (cost 4) when that is shorter. Identifier taps cost 1, label-only taps 1.3, swipes 1.1.
- Before each screenshot, a `waitFor` targets an anchor: a stable identifier that the target
  screen has and the screen before it does not (e.g. `subscription.detail`,
  `calendar.previousMonth`, `insights`, `home.ready`). With this, the flow checks itself on
  replay. The developer's own identifiers win over UIKit's PascalCase ones (`BackButton`) and SF
  Symbol names on images.
- **Verification and repair.**
  1. `explore()` replays the finished flow once, in the exploration's own locale. This takes
     about 30 s and no model calls.
  2. Any screen that fails is rebuilt from its **literal path**: relaunch, then the actions
     actually taken since the last launch, with loops (exact same state) cut out.
  3. The flow is then checked again.

  The graph and the trajectory are saved in `exploration.json`. `cli.ts rebuild` rebuilds a flow
  from them.
- Selectors: identifier when unique; identifier + label when the identifier repeats; label alone
  when there is no identifier. There is always a normalized fallback point.

### Replay (`replay.ts`)

- **Launch.** `replayFlow(driver, flow, { locale, launchArgs, screens })` launches with the
  flow's arguments (or `launchArgs`) plus `-AppleLanguages (xx) -AppleLocale xx_YY`.
- **Taps.** The replayer resolves each tap in a fresh stable snapshot, in this order:
  1. exact selector;
  2. identifier alone, when identifier + label did not match;
  3. for label-only selectors, the label's first segment. "Netflix, $15.49, Monthly, …" matches
     "Netflix, 13,99 €, Monatlich, …".

  Among several matches it takes the one nearest the recorded point.
- **Scrolling into view.** A target that exists but is off screen or under a bar is scrolled into
  view with exact, momentum-free swipes, at most 4 times. Only a target that is not found at all
  falls back to the recorded point.
- **Checks per screenshot:**
  1. the `waitFor` anchor was found;
  2. the visible stable identifiers have a Jaccard similarity of at least 0.5 with the explored
     screen's;
  3. the structure signature has an LCS similarity of at least 0.6.

  All three are language-independent. They need the `screens` records from the exploration.

### Screen judge (`judge.ts`)

- Sends the marked screenshots (440 px wide) to Spark Open. It asks for a ranking for the App
  Store (first three matter most; variety; penalize empty states and near-duplicates), a 1–10
  score, a reason, and an English caption of at most 6 words per screen.
- Output uses `response_format: json_schema`, with a fallback to parsing JSON from the text.
- Saved as `judge.json` next to `exploration.json`.

## Commands

Keys come from `.env.local` (`MUSE_API_KEY`, `BASETEN_API_KEY`). Options that start with `-` go in
`--args=...`, because `parseArgs` rejects option values that start with a dash.

```sh
SP=<scratchpad>; U=93861348-64C1-4AF6-BA6C-41EB31FC73EF; B=yadaumur.Subscription-Tracker

# Renew copy (never the original): 3 min clean build
rsync -a --exclude .git --exclude docs --exclude .build --exclude DerivedData --exclude .swiftpm \
  "/Users/yadaumur/Subscription Tracker/Renew2/" $SP/renew/Renew2/
xcodebuild build -project $SP/renew/Renew2/Renew.xcodeproj -scheme Renew -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$U" -derivedDataPath $SP/renew-dd

# Explore (installs the app, starts the runner, verifies the flow, runs the judge)
node packages/explorer/scripts/cli.ts explore --udid $U --bundle $B \
  --app-path $SP/renew-dd/Build/Products/Debug-iphonesimulator/Renew.app \
  --model spark --effort low --app-name Renew --hint "A subscription tracker." \
  "--args=-seedSampleData -inMemoryStore -sampleRegion US -AppleLanguages (en) -AppleLocale en_US" \
  --max-steps 40 --max-cost 1.0 --judge --out $SP/runs/spark-c
#   --model wonder | open | open-json; --no-verify; --image-scale 0.75

# Replay per locale ({region} is replaced per locale: en->US, de->DE, ja->JP)
node packages/explorer/scripts/cli.ts replay --udid $U --exploration $SP/runs/spark-c/exploration.json \
  --locales en,de,ja "--args=-seedSampleData -inMemoryStore -sampleRegion {region}" --out $SP/runs/spark-c/replay
#   repair (since Oct 28 afternoon): --repair spark|open|none (default spark), --repair-max-cost 0.10,
#   --repair-attempts 2, --flow <other flow.json with the same steps>

node packages/explorer/scripts/cli.ts judge --exploration $SP/runs/spark-c/exploration.json
node packages/explorer/scripts/cli.ts rebuild --exploration $SP/runs/spark-c/exploration.json
```

Output per run:

- `exploration.json`: flow, screen records, ranking, per-turn log, usage, cost, timing, graph,
  verification.
- `flow.json`
- `screens/<name>.png`: full resolution.
- `steps/NNN.jpg` and `steps/NNN.txt`: what the model saw each step.
- `judge.json`, `log.txt`
- `replay/<locale>/<name>.png`, `replay/replay.json`

The CLI applies the 9:41 status bar override.

## The Renew run

Launch arguments: `-seedSampleData -inMemoryStore -sampleRegion US -AppleLanguages (en) -AppleLocale en_US`.
Pass `-AppleLocale en_US` for English: without it, this simulator formats amounts as "$51,63".

### Language

Renew follows `Bundle.main.preferredLocalizations`, i.e. the per-app language from Settings ›
Renew › Language. So `-AppleLanguages (de) -AppleLocale de_DE` switches the text, dates and
number formats. **No reinstall is needed**, unlike DailyAffirmations in the simulator spike. Add
`-sampleRegion DE` / `JP` to get local prices and currency ("50,14 €", "¥8,314").

### Screens picked (final Spark 1.3 run, `runs/spark-c`)

| Explorer rank | Screen | Explorer score | Judge rank, score | Judge caption |
|---|---|---|---|---|
| 1 | home-overview | 10 | 1, 10 | All renewals at a glance |
| 2 | calendar-month | 9 | 2, 9 | Never miss a due date |
| 3 | insights-spend (donut chart) | 9 | 3, 8 | Know where your money goes |
| 4 | subscription-detail (Netflix) | 9 | 5, 6 | Stay ahead of every charge |
| 5 | trial-ending (Disney+ trial) | 8 | 7, 4 | Catch trials before they charge |
| 6 | insights-savings (Insights scrolled) | 8 | 6, 5 | See total savings and forecast |
| 7 | all-subscriptions (All filter) | 7 | 4, 7 | Every subscription in one place |

Judge's note: lead with the three visually distinct screens (home, calendar, insights) and push
the duplicate detail views to the end.

### Recorded flow (19 turns, 10 actions explored → 23 steps, 8 actions)

```
 0 launch  -seedSampleData -inMemoryStore -sampleRegion US -AppleLanguages (en) -AppleLocale en_US
 1 waitFor #home.ready                      2 screenshot home-overview
 3 tap "Netflix, $15.49, Monthly, ..." (0.50,0.49)
 4 waitFor #subscription.detail             5 screenshot subscription-detail
 6 tap #calendar (tab)                      7 waitFor #calendar.previousMonth   8 screenshot calendar-month
 9 tap #chart.pie (tab)                    10 waitFor #insights                 11 screenshot insights-spend
12 swipe up 0.5                            13 waitFor #calendar.badge.clock     14 screenshot insights-savings
15 tap #house (tab; the Home tab still shows the Netflix detail)   16 tap #BackButton
17 tap "All" (0.33,0.37)                   18 waitFor #magnifyingglass          19 screenshot all-subscriptions
20 tap "Disney+, $13.99, ... Trial ends Friday" (0.50,0.69)
21 waitFor #subscription.detail            22 screenshot trial-ending
```

Steps 15–16 show the graph doing its job. The exploration had seen that the Home tab keeps the
pushed detail, so the flow taps Home, then Back. The verification replay passed in round 1.

### Replay per locale (final flows)

| Run | en | de | ja | Time per locale | Taps that used the fallback point |
|---|---|---|---|---|---|
| Spark 1.3 (spark-c, 7 screens) | 7/7 | 7/7 | 7/7 | 26–30 s | de, ja: "All" (segmented control, label only) |
| Spark 1.3 (spark, 6 screens) | 6/6 | 6/6 | 6/6 | 26–29 s | de, ja: "All" |
| Wonder 1.0 (7 screens) | 7/7 | 7/7 | 7/7 | 32–36 s | de, ja: "All", the Insights trial card |
| Spark Open (6 screens) | 6/6 | 6/6 | 6/6 | 42–45 s | de, ja: "Paused" section header, a Spotify row |

Each locale run includes one launch, which takes 10–13 s until the layout is stable. Brand rows
("Netflix, …", "Disney+, …") resolved by selector in de and ja through the first-segment match.
Taps on tab bar buttons use their SF Symbol identifiers (`house`, `calendar`, `chart.pie`), so
they never depend on the language. Screenshots: `runs/<run>/replay/{en,de,ja}/`; contact
sheets: `sheet-picks.jpg`, `sheet-locales.jpg` in the scratchpad.

## Model comparison

Same app, launch arguments, prompt, hint ("A subscription tracker."), 40-turn limit, and `effort: low` for
the Meta models (Spark Open: default effort). Spark 1.3 was run three times to show run-to-run variance.

| | Spark 1.3 (3 runs) | Wonder 1.0 | Spark Open (Baseten) |
|---|---|---|---|
| Turns / actions | 19–23 / 10–16 | **13 / 12** | 21 / 14 |
| Screens marked | 6–7 | 7 | 6 |
| Flow actions (after shortening) | 7–8 | 9 | 12 |
| Exploration time (without verification) | 67–95 s | 85 s | 138 s |
| Model latency per turn | **1.9–2.3 s** | 2.6 s | 4.3 s |
| Input tokens per run (cached) | 80–103 k (77–81 %) | 56 k (62 %) | 93 k (70 %) |
| Output tokens (reasoning) | 2.5–4.0 k (0.6–1.7 k) | 2.1 k (0.3 k) | 5.4 k (3.2 k) |
| Cost per run | **$0.039–0.057** | $0.134 | $0 (list $0.068) |
| Combines mark + action in one turn | no | **yes, every time** | no |
| Plain-text replies | 0–1 per run | 0 | 0 |
| Core four found (home, calendar, insights, detail) | yes, by turn 7–8 | yes, by turn 5 | yes, by turn 10 |
| Extra picks | Insights cards, All list, trial detail | split-cost detail, trial detail, Insights cards, All list | split-cost, trial, Notion details |
| Judge's average score of its picks | 7.0–7.5 | 7.0 | 7.5 |
| Replay en/de/ja | 2 runs all verified; spark-b lost 1 screen (hidden state, before the verification step existed) | all verified | all verified, after the tab-bar fix |

What this means:

- **Pick quality is a tie.** All three models find the same strong screens, give the same top
  three (the judge agrees), and none gets into the Add flow (see Problems).
- **Spark 1.3 is the right default.** It is the cheapest per turn and the fastest. Most of the
  time difference is device time, not model time.
- **Wonder** is the efficient explorer: it marks and acts in one turn and wanders less. But
  per-token prices (3.2x input, 4.7x output) make it 2.5–3.5x the cost of a Spark run. Keep it for
  apps where Spark gets stuck.
- **Spark Open** is a free alternative of the same quality. Its higher latency (vLLM on Baseten,
  more reasoning tokens) makes exploration about 40 s slower. Use it for the judge, captions and
  bulk work, and as a no-cost fallback for exploration.

## Costs

| Run | Model | Cost |
|---|---|---|
| API probes (tools, image tokens) | Spark 1.3 | about $0.004 |
| spark-v1, spark, spark-b, spark-c | Spark 1.3 | $0.063 + $0.057 + $0.048 + $0.039 |
| wonder | Wonder 1.0 | $0.134 |
| **Meta Model API total** | | **about $0.35** of the $5 budget |
| smoke ×2, open, open-json, 7 judge calls | Spark Open | $0 (about 230 k in, 50 k out; list about $0.25) |

A full app run (exploration plus verification) costs about $0.05 on Spark. Replays cost $0. The
judge is free on Baseten.

## Problems found (and what was done)

1. **Cold boot makes the first runner start slow.** The first `test-without-building` after
   booting the simulator took 160 s to answer `/health`, which was more than the 150 s timeout I
   had set. The default is now 300 s, with a progress log every 30 s. Warm starts take 12–15 s; a
   restart after a hang takes 5–6 s.
2. **Floating tab bar hides list rows.** With iOS 26+ Liquid Glass, the tab bar floats over the
   list. An element whose frame is on screen can still be under the tab bar, so a tap hits the
   bar. The first Spark Open replay in English tapped "Paused" through the tab bar and landed on
   Calendar. Fix:
   - elements under a tab bar or navigation bar are hidden from the model;
   - replay scrolls a covered or off-screen target into view before tapping (exact,
     momentum-free swipes).

   After the fix: 6/6 in all locales.
3. **Hidden state breaks graph shortcuts.** In one Spark run the shortest path used an edge
   "tap Home tab → All list". That edge was recorded while the Home tab remembered the "All"
   filter; from a fresh launch the same tap shows "Upcoming", so the screenshot failed in replay.
   A fingerprint cannot see this. Fix: `explore()` now ends with a verification replay and
   rebuilds failing screens from their literal path (see "Recording a short flow"). The final
   Spark run passed in round 1.
4. **Scroll positions drift.** After tab switches, Renew's Home list was 113 pt off from the
   exploration (the summary card changes height once the launch settles). Selectors handle it.
   Coordinate fallbacks for label-only targets in other languages are the weak spot: "All",
   "Paused" and the Insights trial card hit the right element in de and ja, but only because the
   layout matched. Repair for those steps (PLAN, Oct 30) should target label-only steps first.
   **Done:** structural selectors resolve them without a model, and repair covers the rest (see
   "Step repair and structural selectors").
5. **Navigation bars use the localized title as identifier** (`October 2026` / `Oktober 2026`).
   They are now excluded from anchors and from the identifier similarity check.
6. **Paywall in front of the Add flow.** The sample data is above the free tier's limit, so "Add
   subscription" opens the paywall. Every model closed it and moved on, so no run captured the
   service catalog or editor, which would be one of the best screens. Renew already has
   `-showEditor`, `-editorQuery` and `-editorService` launch arguments, but the agent cannot know
   them. Suggestion: let the developer list "screens behind launch arguments" in the demo data
   contract, or add a Debug Pro unlock to `-seedSampleData`.
7. **Near-duplicate picks.** Each run marked 2–3 detail screens with the same layout. The judge
   always ranks them last, so the final set should come from the judge (or the explore prompt
   could say "at most one detail screen").
8. **The flow schema needed workarounds.** **Done:** `type`/`index`/`frame` selectors,
   coordinate-only taps, `expect` and swipe `from` are in the schema now (see "Step repair and
   structural selectors").
9. **Disk full.** The Mac's data volume reached 100 % (583 MB free) during a replay, and one
   replay failed with `ENOSPC`. I deleted my own build intermediates (Renew DerivedData except
   `Build/Products`, the runner's index), leaving 1.5 GB free. The simulator device folder alone
   is 3.5 GB. Watch this before long replay batches.

## Step repair and structural selectors (Oct 28, afternoon)

Simulator: "Shotwright iPhone 6.3" (iPhone 17 Pro, iOS 27.0, 402×874 pt). Renew: the same build
as above, installed on this simulator. New Spark 1.3 run: `runs/spark-63`.

### Summary

| Question | Result |
|---|---|
| Do label-only taps resolve without a model in other languages? | **Yes.** With structural selectors, all 6 taps of the new flow resolved in en, de, ja, ar and tr: 3 by identifier, 3 by structure ("All", the Netflix row, the Insights trial card). 0 by label, 0 repairs, 0 fallbacks, $0. |
| Does RTL work? | **Yes.** Arabic keeps the sibling order and mirrors the frames. Structural matching compares with the mirrored frame, so "All" → "الكل" (x 119 → 261 pt) resolved by structure. Arabic replay: 6/6 screens verified. |
| Does repair work when selectors fail? | **Yes, 12 of 12.** Each repair needed 1 attempt: 8 label-only taps (legacy flow, de/ja/ar/tr), 2 taps in yesterday's 6.9" flow replayed on the 6.3", and 2 screen repairs after a deliberately wrong coordinate tap (en, ar). |
| Repair cost and speed | **Spark 1.3: $0.0023–0.0045 per repair, 1.9–3.3 s.** Spark Open (Baseten): $0, 4.5–19 s, the same picks. |
| Does the flow verify itself without `exploration.json`? | Yes. Screenshot steps now carry `expect` (identifiers that must be visible, title, type sequence). |
| Old flows | All 8 flow files from yesterday parse with the new schema. spark-c, recorded on the 6.9", replays on the 6.3" in de and ar with 7/7 screens verified (one repair each). |
| Meta API spend for this work | **$0.106** of $3: $0.068 for the exploration, $0.038 for 12 repairs. |

### Flow schema changes (`packages/core/src/flow.ts`, backward compatible, still `version: 1`)

- **`ElementSelector`** gets three optional fields:
  - `type`: the element type, e.g. `"button"`;
  - `index`: position among the parent's children of the same type, 0-based;
  - `frame`: the element's normalized frame when recorded.

  A selector now needs `id`, `label` **or** `type`. Note that `index` is **not** the runner's
  `index` (the runner's means "n-th match of the whole query"), so drivers must ignore it.
  The explorer strips `index` and `frame` before handing a selector to a driver
  (`driverSelector`).
- **`TapStep`**:
  - `target` is optional;
  - new `point` field: a coordinate-only tap is `{ action: "tap", point: {x, y} }`;
  - one of `target` or `point` is required.
- **`SwipeStep.from`**: optional normalized start point. The finger moves `distance` × the
  target (or screen) size in `direction`.
- **`ScreenshotStep.expect`**: `{ ids, title?, structure? }`.
  - `ids` must all be visible: the `waitFor` anchor plus up to two of the developer's own
    identifiers on views, not counting bar items, images or UIKit's PascalCase ids.
  - `title` is the localized title when recorded. It gives the repair model context and is
    not checked.
  - `structure` is the element type sequence, compared by LCS with a threshold of 0.6.
- New exports: `NormalizedRectSchema`, `ExpectedScreenSchema`, and the types `NormalizedRect`
  and `ExpectedScreen`.

### Recording (`explore.ts`, `actions.ts`, `recorder.ts`)

- A tap on an element without a unique identifier records label + `type` + `index` + `frame`,
  for example:

  ```json
  {"label":"All","type":"button","index":1,"frame":{"x":0.296,"y":0.381,"w":0.1095,"h":0.0503}}
  ```

  A repeated identifier (Renew's `calendar` is on both the tab button and its image) also gets
  the structure.
- Taps that could not be recorded before are now kept:
  - an element with no label and no id is recorded by structure alone;
  - a `tap_at` that hits nothing labelled is recorded as a coordinate-only tap.
- A from/to swipe records `from`.
- `FlatNode` has `siblingIndex` and `parent`. `Observation` has `viewIds`.
- `FlowRecorder.build()` also returns `sources`: for each flow step, the observation it was
  recorded on, taken from the edge (new `Edge.observation`).
  - `explore()` saves it as `ExplorationResult.stepSources`.
  - steps/NNN.jpg of that observation is the repair reference.

### Resolution order in replay (`resolveTarget`)

1. **Identifier.** Label, type and index break ties, e.g. `#calendar` + type `button` when the
   label is "Kalender".
2. **Structure:**
   - same `type`, same `index` among its siblings;
   - the frame overlaps the recorded one, or its centre is within 15 % of the screen (layouts
     drift: Arabic text pushed "All" down 12 pt);
   - right-to-left languages also try the mirrored frame;
   - when the recorded label's leading name ("Netflix" in "Netflix, $15.49, …") is visible on
     *another* element, the rows have moved, and the name wins over the position.
3. **Label:** exact label, then the leading segment.
4. **Not found:**
   - with `repair`: a model repair (below);
   - without `repair`: the recorded point.

   Recorded points and coordinate-only taps are mirrored for right-to-left languages, and so
   are horizontal swipes (direction and `from`).

### Repair (`repair.ts`; `replayFlow(..., { repair })`, off unless passed)

**When it runs:**
- a tap whose target resolves to nothing (after the usual scroll-into-view);
- a screenshot step that fails its checks: anchor, `expect.ids`, structure, the exploration's
  identifier similarity. A missing `waitFor` anchor right before a screenshot is logged as
  `miss`, and the screenshot step repairs it.

**What the model gets:**
- the explorer's observation of the current screen (402-px JPEG + element list);
- the recorded step: type, label, id, index, and position on the 0–1000 grid;
- the replay locale, and whether the layout is mirrored;
- what should be true afterwards: the next `waitFor` anchor, the next screenshot, or the next
  step's target;
- when available, the screenshot the step was recorded on, with the target outlined in red
  (`outlineTarget`; example: `repair-reference-all.jpg` in the scratchpad).

**Tools:** `tap(element_id)`, `tap_at(x, y)`, `swipe(direction)`, `give_up(reason)`.

**After each action** the replayer checks the expected outcome:
- the next `waitFor` anchor appears (3 s);
- or the next screenshot's checks pass;
- or the next step's target can be found and the screen changed;
- otherwise, at least the screen changed.

**Limits:**
- 2 model calls per step (`maxAttemptsPerStep`);
- $0.10 per replay (`maxCostUsd`).

**When repair fails:**
- If the model never acted (it gave up, or the budget ran out), the tap falls back to the
  recorded point (`via: "fallback"`).
- If it acted and failed, the step fails.

**Models:**
- `provider: "spark"` (default): Muse Spark 1.3, effort low, prompt cache key
  `shotwright-repair-v1`;
- `"open"`: Spark Open on Baseten, free;
- or any `ExplorerProvider`.

**Results:**
- `ReplayStepResult.via`: `id` | `structure` | `label` | `repair` | `fallback` | `point`, plus
  `repair`;
- `ReplayResult.repairs` and `repairCostUsd`. Each `RepairRecord` has the step, kind (`tap` or
  `screen`), the attempts (action, element, reason, tokens, ms, cost), `chosen` (the selector
  that worked in this locale) and `note`.
- `ReplayShot.repaired`;
- `ReplayCheck.missingIds`.

**Launch:** if `driver.launch` throws but the app turns out to be in the foreground, the launch
step passes. Otherwise it relaunches once.

**CLI:**

```
replay ... --repair spark|open|none --repair-max-cost 0.10 --repair-attempts 2 [--flow other-flow.json]
```

- Reference images come from `stepSources` + `steps/NNN.jpg`.
- The log ends with a matrix row per locale.

### Replay matrix: new flow (`runs/spark-63`, 6 screens, 21 steps, 6 taps), repair on (Spark 1.3)

| Locale | id | structure | label | repair | fallback | failed | Screens verified | Time | Repair cost |
|---|---|---|---|---|---|---|---|---|---|
| en | 3 | 3 | 0 | 0 | 0 | 0 | 6/6 | 108 s* | $0 |
| de | 3 | 3 | 0 | 0 | 0 | 0 | 6/6 | 61 s | $0 |
| ja | 3 | 3 | 0 | 0 | 0 | 0 | 6/6 | 61 s | $0 |
| ar (RTL) | 3 | 3 | 0 | 0 | 0 | 0 | 6/6 | 51 s | $0 |
| tr | 3 | 3 | 0 | 0 | 0 | 0 | 6/6 | 82 s* | $0 |

\* Includes a slow relaunch: in en the layout did not settle for 30 s, and tr had a 33 s
launch. The other launches took 11–14 s.

Structural matches, as resolved:

| Recorded | de | ja | ar | tr |
|---|---|---|---|---|
| "All" (segment) | Alle | すべて | الكل (mirrored) | Tümü |
| Netflix row | Netflix, 13,99 €… | Netflix, ¥2,490… | Netflix, ‏٥٨٫٩٩ ⃁… | Netflix, ₺229,99… |
| "Disney+ trial ends in 2 days, …" card | "Disney+: Probeabo endet…" | "Disney+の無料トライアル…" | "تنتهي الفترة التجريبية في Disney+…" | "Disney+: deneme 2 gün…" |

The trial card shows why the leading-name rule only applies when the name is visible elsewhere.
Its first segment is localized ("Disney+ trial ends in 2 days" → "Disney+: Probeabo endet in
2 Tagen"), so a strict "same leading name" rule would have sent it to repair.

Contact sheet: `sheet-structural-locales.jpg`. All 30 screens are right, and the Arabic row is
mirrored.

### Repair matrix: the same flow without structure (legacy label-only selectors, `flow-legacy.json`)

| Locale | id | label | repair (attempts) | failed | Screens | Spark 1.3 cost | Spark Open cost (list) |
|---|---|---|---|---|---|---|---|
| en | 3 | 3 | 0 | 0 | 6/6 | $0 | not run |
| de | 3 | 1 | 2 (1 + 1) | 0 | 6/6 | $0.0088 | $0 ($0.0075) |
| ja | 3 | 1 | 2 (1 + 1) | 0 | 6/6 | $0.0057 | $0 ($0.0061) |
| ar | 3 | 1 | 2 (1 + 1) | 0 | 6/6 | $0.0063 | $0 ($0.0074) |
| tr | 3 | 1 | 2 (1 + 1) | 0 | 6/6 | $0.0062 | $0 ($0.0062) |

- The Netflix row resolved by label (its leading segment).
- "All" and the trial card were repaired. Both models picked the same elements in every locale:
  Alle / すべて / الكل / Tümü, and the localized trial card.
- Per repair call: about 2.9 k input tokens (two screenshots + element list, 37–42 % cached
  after the first call) and 130–430 output tokens.
- Latency: Spark 1.3 1.9–3.1 s; Spark Open median 5.2 s, worst 19 s.

Sheets: `sheet-repair-spark-locales.jpg`, `sheet-repair-open-locales.jpg`.

### Screen repair and cross-device

- **Screen repair** (`flow-broken.json`). The Calendar tab tap was replaced with a wrong
  coordinate-only tap at (0.5, 0.62). In en and ar:
  - the `waitFor` missed, after its 10 s timeout;
  - the screenshot step repaired it in 1 attempt: the model tapped Calendar / التقويم,
    $0.0026 / $0.0029;
  - all following steps resolved as usual: 6/6. Sheet: `sheet-screen-repair.jpg`.
- **Yesterday's spark-c flow (6.9", label-only, no `stepSources`) on the 6.3"**, de and ar:
  - 7/7 verified;
  - "All" repaired without a reference image ($0.0023 / $0.0031);
  - the Netflix and Disney+ rows matched by label.

### Costs

| Item | Model | Cost |
|---|---|---|
| Exploration `spark-63` (27 turns, 20 actions, 241 s, including verification) | Spark 1.3 | $0.068 |
| 8 repairs, legacy flow | Spark 1.3 | $0.027 |
| 2 screen repairs + 2 repairs on spark-c | Spark 1.3 | $0.011 |
| **Meta Model API total** | | **$0.106** (budget $3) |
| 8 repairs, legacy flow | Spark Open | $0 (24 k in, 2 k out; list $0.027) |
| Judge for `spark-63` | Spark Open | $0 (list $0.026) |

Expected cost in production:
- flows recorded with structure: $0 per locale for Renew;
- label-only flows: about $0.003 per broken step per locale;
- the $0.10 cap allows about 25 repairs per replay.

### What still fails or is weak

1. **Slow launches.**
   - A launch can take 30–55 s: `/source` timed out after 30 s once, and once the layout did
     not settle within 30 s.
   - Replay now tolerates a launch that threw while the app came up, but the time is lost.
   - The runner (packages/agent) should give the first `/source` after a launch more time, or
     find out what Renew animates on Home.
   - **Done (Oct 28, evening):** the cause was the Mac's memory pressure plus a false hang
     detection, not an animation; see "Capture settling and launch latency".
2. **A structural false positive is not caught at the tap.** If the target is gone and another
   element with the same type and index sits within 15 % of the screen, replay taps it. The
   screenshot checks and screen repair catch this later, but only at the next screenshot.
3. **Lazy lists.** `index` counts loaded siblings, and rows are usually index 0 in their own
   cell, so for list rows "structure" means "same position on screen". Reordered rows fall back
   to the leading name; a reordered row whose name is localized would pick the wrong row.
4. **Two attempts.** A screen repair that needs more than two actions fails (wrong tab +
   scrolled away + a segment). Each test today needed one.
5. **A missing anchor costs its full `waitFor` timeout (10 s)** before the screenshot step
   repairs.
6. **Repairs are not written back.** `RepairRecord.chosen` has the working selector per locale;
   patching the flow (or a per-locale overlay) is a follow-up. **Done:** `flow.repaired.json`
   (see "Capture settling and launch latency").
7. **`expect.ids` on other device classes.** "Must be visible" can fail when a smaller or
   different layout pushes an id off screen. That spends a repair, then fails verification.
   Not tested on iPad yet.
8. **Mirroring assumes the app mirrors.** Coordinate-only taps on content that does not mirror
   (charts, images) land on the wrong side in Arabic and rely on screen repair.

## Capture settling and launch latency (Oct 28, evening)

Simulator "Shotwright iPhone 6.3" (iPhone 17 Pro, iOS 27.0, 402×874 pt). Renew rebuilt from the
scratchpad copy with `ENABLE_DEBUG_DYLIB=NO` (see "Launch latency"). The Mac was under heavy
memory pressure all evening (about 60 MB free, 6 GB in the compressor, Time Machine and
CacheDelete running, load average 2–17), so launch times vary by 3x between runs; the launch
comparisons below are interleaved A/B runs for that reason.

### Summary

| Question | Result |
|---|---|
| Why was "all-subscriptions" blurred in spark-63? | **A leftover scroll offset, plus a capture taken too early.** The flow reached it with "relaunch, tap All, swipe up 0.5". The swipe was the model's turn 14 ("reveal more subscriptions"); it wandered 11 more turns and marked the screen at turn 26 after coming back to the Home tab, which had kept the offset. At that offset the large title is collapsed and the Adobe and Disney+ rows sit under the status bar and navigation bar, blurred by the iOS 26 scroll-edge effect. The exploration's PNG and all five replays are pixel-identical in that area, so it was not timing. The timing part: every capture was taken about 0.2 s after the swipe (the tree was already stable), with the **scroll indicator still visible**. A settled capture of the same flow differs in 1.07 % of pixels, all along the right edge. It was not the title animation: every frame had the inline title fully collapsed. |
| Fix | **Capture settling** before every mark and every replay screenshot: a stable tree, then two near-identical screenshots, with a 4 s cap. **List roots go back to the top**: before a mark, a navigation root that an earlier action left scrolled is scrolled to the top (recorded as a new `scrollToTop` flow step). A swipe right before the mark is treated as deliberate and kept. Screens recorded at the top carry `expect.atTop`, and replay scrolls them back if needed. |
| Result on Renew | New Spark 1.3 exploration (25 turns, $0.056, 7 screens). It ran into the same situation as spark-63 (swipe on the All list, five detours, then the mark) and scrolled back via the status bar first. **Replay en/de/ja/ar/tr: 35/35 verified, 41–45 s per locale**, 6 taps by id and 4 by structure per locale, 0 repairs, $0. Every capture settled on the first pair (0.40–0.49 s), and the cap was never hit. All 35 screenshots are clean: no blur, no scroll indicator, large titles. |
| Slow first `/source` after launch | **Not the runner.** Renew stays blank for 4–25 s on this Mac: dyld is page-faulting under memory pressure, then XCTest has to attach to the new process. The first snapshot answers 0.1–0.7 s after the content is visible. The 30–55 s launches and the restarts came from the driver: `/health` was queued behind the blocked `/source`, so after a 30 s timeout and 15 s of silence the driver declared the runner hung and restarted it. |
| Launch fix | `/health` is now answered while the runner is busy (`busy: {route, ms}`), so a busy runner is waited for, not restarted. Launch readiness is now "source-first": `/source` at once, then a stable non-blank picture (new `/frame` route) and one more equal layout, instead of a fixed 1.5 s layout window. **First observation after the content is visible: median 3.4 → 2.6 s (5 rounds) and 3.0 → 2.1 s (4 rounds).** Well inside the 5 s target. |
| `index` mismatch | `RunnerDriver` no longer forwards a flow selector's `index` or `frame`. The runner's own `index` (n-th match) is `RunnerSelector.nth`. Documented in the driver, the flow schema and the runner README. |
| API for the web app | `onStep` and `signal` on `explore()` and `replayFlow()`. `reasoning`, `usage`, `ms` and `costUsd` on the `turn` event. `repair: { provider: "spark" \| "open" }` works alone (references and `flow.repaired.json` come from the run directory). All tested on the device (below). |
| Meta Model API spend | **$0.165** of $2: two explorations ($0.109 + $0.056). Repairs ran on Spark Open (Baseten, $0). |

### Cause, in the run data

```
spark-63 flow, last screen:      16 launch  17 tap "All"  18 swipe up 0.5  19 waitFor #icloud.fill  20 screenshot all-subscriptions
exploration log:   turn 14 swipe up ("Reveal more subscriptions in All list")
                   turns 15-25: Add -> paywall -> Hulu detail -> back -> Insights -> ... -> Home tab
                   turn 26 mark_screen all-subscriptions          (the Home tab kept the 0.5-screen offset)
verification:      the shortcut failed (hidden state), the literal path kept turn 14's swipe
```

- Old capture versus settled capture of the same flow (en, `runs/spark-63/replay` versus
  `replay-settle-old`): 5 screens are identical. all-subscriptions differs by mean 0.40 levels
  and 1.07 % of pixels, in rows 81–188 of a 209-row thumbnail at the right edge: the scroll
  indicator. Side by side: `probe3/allsub-old-vs-settled.jpg`.
- In the same replay, renewal-calendar needed 4 screenshots (3.4 s) before two matched, right
  after the tab switch. Both old and settled PNGs ended up identical, so the old capture was
  lucky there.

### Capture settling (`packages/explorer/src/capture.ts`)

`settleCapture(driver, { bundleId, log, signal }, { timeoutMs = 4000, intervalMs = 120, maxMeanDiff = 0.6, maxChangedShare = 0.002 })`:

1. stable tree (`stableSource`: two equal layouts);
2. screenshots until two consecutive ones match. They are compared as 96-px-wide grey
   thumbnails: mean absolute difference ≤ 0.6 levels, and at most 0.2 % of pixels changed by
   more than 12 levels. A blinking caret or a tiny spinner passes; a title collapse, a
   cross-fade or a scroll indicator does not;
3. if the picture moved, the tree is checked again with a fresh snapshot (bypassing the
   driver's 1-s cache);
4. at the cap: `capture "<name>": the picture did not settle within 4000 ms (last change: mean
   X, Y % of pixels); using the last frame`.

- Where it runs: explore's marks (the marked PNG is the settled one, taken right before the
  mark) and every replay screenshot step, including explore's verification replay.
- It needs only `source()` and `screenshot()`, so the server-side explorer gets the same
  behaviour over the WebSocket driver (at the cost of two screenshot transfers per capture).
- Cost: 0.40–0.49 s per capture when nothing moves (two screenshots), up to the cap otherwise.
- Off with `settle: false`, or `--no-settle` in the CLI.

### List roots back to the top (`scroll.ts`, `explore.ts`, `replay.ts`)

**Detection** (`listScrollState(nodes, screen)`), from the tree alone:
- the navigation bar at the top; a navigation root has no `BackButton` in it;
- the main scroll container: the largest collectionView / table / scrollView / webView
  covering at least half the screen;
- scrolled: any of its cells, texts, buttons or images sits above the navigation bar's bottom
  edge.

On Renew's Home:
- at launch: bar 62–168 with the large title, first cell at 168;
- after the swipe: bar 62–116, first cell at −6;
- after the status-bar tap: bar 62–222 (large title plus the search field), first cell at 222.

**Scrolling** (`scrollToTop`):
1. A tap on the status bar, left of the Dynamic Island: UIKit's scroll-to-top. Works on Renew,
   3.4–3.5 s including settling.
2. If the list is still scrolled: up to 6 momentum-free drags, each no longer than the visible
   offset plus 8 pt, so pull-to-refresh is never triggered by overshooting.

**Exploration rule** (before a mark):
- Applies to a navigation root left scrolled when the last action was not a vertical swipe.
- Capture the scrolled screen first, then scroll to the top and observe.
- If the top is already marked (same state, or the same cluster): the scrolled content is the
  point, so the mark keeps the scrolled position and capture. Exploration 1 showed why: the
  model came back to a scrolled Insights tab to mark "insights-savings" (forecast and savings
  cards). Without this check the scroll made it a duplicate of "insights-spend", and the screen
  was lost.
- Otherwise the top is marked.
- Either way, the transition is recorded as a `{ "action": "scrollToTop" }` step, and the model
  gets a note plus the new observation. An action in the same turn is not executed, because
  its element refs are stale.

**Replay:**
- The `scrollToTop` step runs the same function.
- Screenshot steps with `expect.atTop` that find their list scrolled are scrolled back first
  (`ReplayShot.scrolledToTop`). This catches offsets left by scroll-into-view swipes or by tabs.

**Schema** (`flow.ts`, still `version: 1`, old flows parse unchanged):
- new step `ScrollToTopStep`;
- `ExpectedScreen.atTop?: boolean`.

### Shorter literal paths (`recorder.ts`)

Exploration 1 rebuilt all-subscriptions from its literal path after the shortcut failed
verification (hidden "All" filter state). The path had 10 actions: All, Add, close paywall,
Calendar, a day, Done, next month, Insights, swipe, Home.

Loops were cut only when the exact same fingerprint came back. "All list with the search field
revealed" and "without it" are 0.85 similar, so the loop was never closed.

Now:
- `literalPath(name, "loose")` also cuts when a screen at least 0.8 similar comes back. Here
  that gives "launch, tap All".
- explore() tries the loose path first and falls back to the exact path if verification still
  fails.
- `verification.looseLiteral` records which screens use the loose path; `cli.ts rebuild`
  honours it.

### Launch latency

**Measurements, old driver.** The first `/source` was sent right after `simctl launch`:

| | run 1 | run 2 | run 3 | run 4 |
|---|---|---|---|---|
| first `/source` answered (time spent inside the runner) | 11.2 s (10.0) | 10.9 s (10.4) | 13.2 s (12.8) | 10.5 s (10.0) |
| layout stable | 13.6 s | 12.6 s | 16.0 s | 13.0 s |

Sent 12 s after the launch, the first `/source` answered in 0.9–1.3 s. The runner was only
waiting for the app.

**Where the time goes** (os_log of testmanagerd and the runner, `sample` of the app):

- **The snapshot request.** testmanagerd logs "Recorded pending request for target session with
  pid N, timeout 60.0". Then:
  - 5.0 s until the app registers ("Creating target bootstrap session");
  - 2.6 s to "Got main window";
  - 1.8 s to "Capturing hierarchy".
  There is no idle or quiescence wait on snapshots: "Wait for … to idle" only appears before
  synthesized taps, and lasts 0.05–0.07 s.
- **The app.** It shows a blank white screen until 6–7.5 s, then the empty state ("No
  subscriptions yet"), then the data at 7.3–9 s. Screenshot sequence: `probe3/seq-strip*.jpg`.
- **Why it is blank.** `sample` at 2.5–3 s shows the main thread still in dyld, at 6–36 % CPU:
  page faults. With the default Debug build the time is in `__debug_blank_executor_main` →
  `dlsym` into the 20 MB `Renew.debug.dylib`. With `ENABLE_DEBUG_DYLIB=NO` it is in initializers,
  and the app was still blank until ~6 s, so there was no clear gain. Not adopted as a pipeline
  default (it would be a change to `app.build` in packages/agent).
- **The 30–55 s launches and restarts.** The old runner answered `/health` on the main-thread
  queue too. While the first `/source` waited for a slow app:
  1. the driver's `/source` timed out after 30 s;
  2. `/health` stayed silent for the 15 s hang check;
  3. the driver restarted the runner (5–40 s);
  4. the retried `/source` waited for the app again.
  Under heavy load this evening, a first `/source` took up to 38.6 s.

**Tried:**

| Idea | Outcome |
|---|---|
| Snapshot with a shorter idle timeout | Not applicable: snapshots don't wait for idle on Xcode 27.1. The only knob is the private AX messaging timeout (60 s), which would just make the call fail sooner while the app is still loading. |
| Poll `XCUIApplication(bundleIdentifier:).state` before the first snapshot | Added as `GET /state` (and in `/frame`). It is cheap but not a readiness signal: an app is `foreground` from its first, blank frame, and right after `simctl launch` it can still report `notRunning`. |
| `simctl launch`, attach only once the app is visible ("frames-first") | Implemented as `launchReadiness: "frames-first"`. The first `/source` then took 2.3–5.4 s *after* the picture was stable, because XCTest's attach starts only then. Not faster than asking at once (3 interleaved rounds: 16–26 s versus 13–19 s for the old rule). Kept as an option. |
| Disable animations via a launch environment | Renew has no such argument, and UIKit has no environment switch. Not pursued: the time is spent before the first frame. |
| `ENABLE_DEBUG_DYLIB=NO` | See above: no clear gain on this machine. |

**Kept:**

1. **Busy-aware `/health`** (`RunnerTests.swift`). While a request holds the main thread,
   `/health` is answered from the HTTP queue in 3–19 ms, from cached values, with
   `busy: {route: "GET /source", ms, queued}`. On a timeout, `RunnerDriver` asks `/health`:
   - busy: wait (up to `timeouts.busy`, 90 s), then retry the read. An action that finished
     in the meantime counts as done;
   - silent: restart, as before.
   A frozen runner (the SIGSTOP hang test) should still be restarted, because `/health`
   stays silent then too. Not re-tested this evening.
2. **`GET /frame`**: a 72×156 grey thumbnail of the screen plus the app state, from
   `XCUIScreen` (system, not accessibility), so it never waits for the app.
3. **Source-first launch** (default `launchReadiness`). The steps:
   1. Home, then `simctl launch`;
   2. `/source` at once with a 90 s budget, so XCTest's attach overlaps the app's own launch;
   3. `/frame` until the picture is non-blank and unchanged for 0.5 s;
   4. one more `/source` with an equal layout.
   This replaces the 1.5 s layout window. Each launch logs `launched <bundle> (source-first):
   simctl X ms, first /source at Y ms, stable picture at Z ms, stable layout at W ms` and
   records it in `driver.lastLaunch`.

**Before and after.** Interleaved A/B on the same runner build. "Content visible" comes from
independent `simctl io screenshot` polling: the first frame equal to the final observation's.

| Rounds | Mode | First observation − content visible | Median | Launch → first observation |
|---|---|---|---|---|
| 5 (window 0.6 s) | layout (old rule) | 3.4, 3.7, 3.5, 2.8, 2.9 s | **3.4 s** | 6.9–16.0 s |
| | source-first | 3.5, 3.3, 2.3, 2.2, 2.6 s | **2.6 s** | 6.7–15.0 s |
| 4 (window 0.5 s, final) | layout (old rule) | 3.0, 3.3, 2.9, 2.9 s | **3.0 s** | 6.9–14.6 s |
| | source-first | 2.4, 2.1, 2.2, 2.0 s | **2.1 s** | 6.1–7.8 s |

In both modes the first `/source` answers 0.1–0.7 s after the content is visible. Launches
inside the replays above: stable 9.7–12.7 s after the start of `launch()` (simctl 1.9–2.9 s of
that, under load).

### API additions (backward compatible; existing callers unchanged)

`explore(options)`:
- `onStep?: (e: ExploreStepEvent) => void`: `{ phase: "explore", step: StepLog }` after every
  model turn (calls with outputs, usage, reasoning, model and device time, observation);
  `{ phase: "verify", round, step: ReplayStepEvent }` during verification.
- `signal?: AbortSignal`: the loop stops at once. An in-flight model call is abandoned; a
  device call finishes. Verification is skipped, the flow is built from what was marked, and
  the result has `stoppedBecause: "aborted"`.
- `settle?: CaptureSettleOptions | false`, `scrollToTop?: boolean` (default true).
- `turn` events now carry `reasoning?`, `usage`, `ms`, `costUsd`.

`replayFlow(driver, flow, options)`:
- `onStep?: (e: ReplayStepEvent) => void`. The event is a `ReplayStepResult` plus `total`,
  `status` (`ok` | `miss` | `failed`), `locale` and, for screenshot steps, `shot` (PNG, checks,
  capture).
- `signal?: AbortSignal`: stops before the next step; `result.aborted`.
- `repair: { provider: "spark" | "open" }` is enough:
  - `maxCostUsd` defaults to $0.10 and `maxAttemptsPerStep` to 2;
  - references are loaded from `<runDir>/steps/NNN.jpg` through `stepSources`, read from
    `<runDir>/exploration.json` when its flow has the same step sequence.
- `runDir?`: default is the nearest directory above `outDir` (up to 3 levels) with an
  exploration.json, so the web app's `outDir: <run>/replay/<locale>` works as is.
  `stepSources?` overrides.
- `saveRepairs?` (default true): successful repairs are written to `<runDir>/flow.repaired.json`.
  The original is untouched. Result: `repairedFlow`, `repairedFlowFile`, `patches`.
  - Tap repairs keep the recorded label and take the picked element's id, type, sibling index
    and frame. Frames are un-mirrored for right-to-left locales.
  - A one-action screen repair inserts that action before the screenshot's `waitFor`.
  - Patches from several locales accumulate in the file; the first per step wins.
- `settle?: CaptureSettleOptions | false`.
- `ReplayShot.capture` (frames, waitedMs, settled), `ReplayShot.scrolledToTop`.

Runner module: see "Runner module API" below:
- `launchReadiness`, `lastLaunch`;
- `frame()`, `waitForVisible()`;
- `health().busy`;
- `RunnerSelector.nth`;
- timeouts `frame` and `busy`.

**Tested on the device** (`probe3/api-test.ts`, against yesterday's spark-63 run):
- **abort:** abort from `onStep` at the first screenshot → `aborted: true` after 3 steps and 3
  events;
- **repair with only `{ provider: "open" }` and `outDir: runs/spark-63/replay-autorepair/de`**
  on the label-only legacy flow:
  - the run directory was found and the references loaded;
  - 2 repairs (the trial card and "Alle"), $0 (Spark Open took 9 s and 45 s);
  - 6/6 verified;
  - `flow.repaired.json` written;
- **that repaired flow, replayed in ja with no repair:** 6/6, taps by id 3, structure 2 (the two
  patched steps), label 1.

### Replay matrix (`runs/spark-settle2`, 7 screens, 28 steps, 10 taps + 1 scrollToTop), settling on, repair available (Spark 1.3, $0.10 cap)

| Locale | id | structure | label | repair | fallback | failed | scrollToTop | Screens verified | Capture (per screen) | Launch | Time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| en | 6 | 4 | 0 | 0 | 0 | 0 | status bar, 3.4 s | 7/7 | 2 frames, 0.40–0.45 s | 11.8 s | 43 s |
| de | 6 | 4 | 0 | 0 | 0 | 0 | status bar, 3.4 s | 7/7 | 2 frames, 0.41–0.49 s | 12.7 s | 45 s |
| ja | 6 | 4 | 0 | 0 | 0 | 0 | status bar, 3.5 s | 7/7 | 2 frames, 0.43–0.46 s | 11.6 s | 43 s |
| ar (RTL) | 6 | 4 | 0 | 0 | 0 | 0 | status bar, 3.5 s | 7/7 | 2 frames, 0.43–0.48 s | 9.7 s | 41 s |
| tr | 6 | 4 | 0 | 0 | 0 | 0 | status bar, 3.5 s | 7/7 | 2 frames, 0.42–0.45 s | 11.0 s | 42 s |

- Contact sheet: `sheet-settle-locales.jpg`. All 35 screens are right, and none is blurred or
  mid-scroll. all-subscriptions shows the large title, the search field, the summary card and
  the filters in every locale, mirrored in Arabic (`probe3/allsub-settle2.jpg`).
- Explorations:
  - **`runs/spark-settle`** (first try): 37 turns, $0.109, 6 screens, all clean. It exposed the
    two problems fixed above: the lost insights-savings, and the 10-action literal path.
  - **`runs/spark-settle2`**: 25 turns, 17 actions, 7 screens, 138 s plus 43 s of verification
    (passed in round 1).
- Judge (Spark Open) ranking for spark-settle2: home-overview, spending-insights,
  renewal-calendar, subscription-detail, split-cost-detail, all-subscriptions,
  cancelled-savings.

### Still open

- `scrollToTop` costs 3.4 s: tap, settle, a 0.4 s pause and two fresh stable snapshots. It
  could be trimmed.
- The rule "a swipe right before the mark is deliberate" keeps the scroll-edge blur for screens
  the model scrolled on purpose. That is the iOS 26 look, but a capture option to scroll to the
  next row boundary could make those cleaner.
- Launch time is bounded by the app and the Mac (4–25 s to first content here). Capturing
  several screens per launch, as the flows already do, matters more than anything in the runner.

## Runner module API (for the WebSocket agent)

```ts
import { ensureRunner, RunnerDriver, RunnerRestartedError } from "./runner/index.ts";

const handle = await ensureRunner({
  udid,                     // required
  port?,                    // default 8615
  derivedDataPath?,         // default ~/Library/Caches/Shotwright/runner/xcode-<version>-<build>
  boot?,                    // default true: boots the simulator if it is shut down
  forceRebuild?, projectDir?, healthTimeoutMs?, // default 300 s
  driver?: { timeouts?, settleAfterActions?, settle?, launchReadiness? }, // "source-first" (default) | "frames-first" | "layout"
  log?: (message) => void,
});
handle.driver   // RunnerDriver implements DeviceDriver
handle.screen   // ScreenInfo in points, e.g. { width: 440, height: 956, currentBundleId }
handle.process  // RunnerProcess: restart(), stop(), healthy(), logPath, owned
await handle.stop();        // POST /shutdown, then kills xcodebuild if needed
```

- `RunnerDriver` covers all of `DeviceDriver`. Each call settles on its own: `launch` asks for
  `/source` at once, then waits for a stable non-blank picture (`/frame`, 0.5 s) and a second,
  equal layout (see "Capture settling and launch latency"); actions wait for two equal snapshots.
  `driver.lastLaunch` has the timing of the last launch.
- Extras:
  - `waitForStable({ bundleId?, timeoutMs?, minStableMs? })` returns the snapshot plus
    `stable`, `waitedMs` and `firstMs`;
  - `waitForVisible({ bundleId?, timeoutMs?, minStableMs?, blankAcceptMs? })`: picture-only wait;
  - `frame(bundleId?)`: grayscale thumbnail + app state from `GET /frame`;
  - `health()`: while the runner is busy, `busy: { route, ms, queued }`;
  - `launchViaRunner()` uses XCUI `launch()`; avoid it right after an install.
- Selectors: a flow selector's `index` (sibling position) and `frame` are never forwarded; the
  runner's own `index` (n-th match of the query) is `RunnerSelector.nth`.
- On a timeout the driver asks `/health`: a busy runner is waited for (up to `timeouts.busy`,
  90 s), one that does not answer is restarted. Don't recreate the driver because one call
  timed out:
  - reads are retried once;
  - a timed-out action that finished while the driver waited counts as done;
  - after a restart, actions throw `RunnerRestartedError`, after which you observe again.
- Timeouts (ms), overridable: health 3,000, source 30,000 (the first `/source` after a launch:
  90,000), screenshot 10,000, frame 10,000, tap 20,000, swipe 15,000, type 30,000, home 10,000,
  launch 90,000, hang check 15,000, busy 90,000.
- Also exported: `simctl` (`installApp`, `launchApp`, `terminateApp`, `bootAndWait`,
  `listDevices`), `layoutHash`, `findFrame`, `contentShare`, `frameDiff`, `sameFrame`, and the
  error classes.
- The explorer runs against any `DeviceDriver`. It uses `waitForStable` when the driver has it
  and otherwise polls `source()`, so the WebSocket driver needs nothing extra.

## Explorer API

```ts
import { explore, replayFlow, judgeScreens, createProvider } from "@shotwright/explorer";

const result = await explore({ driver, provider: createProvider("spark", { reasoningEffort: "low" }),
  bundleId, launchArgs, appName: "Renew", hint, maxSteps: 40, maxCostUsd: 1, outDir, log,
  onEvent,      // observation (JPEG), turn (text, calls, reasoning?, usage, ms, costUsd), action (reason), mark (PNG)
  onStep,       // { phase: "explore", step: StepLog } after every turn; { phase: "verify", round, step: ReplayStepEvent }
  signal,       // AbortSignal: stops at once, skips verification, stoppedBecause "aborted"
  settle,       // CaptureSettleOptions | false (default on: 4 s cap)
  scrollToTop,  // default true
});
// result: flow, screens, ranked, notes, usage, costUsd, timing, steps, graph, verification

const replay = await replayFlow(driver, result.flow, { locale: { language: "de" },
  launchArgs: ["-seedSampleData", "-inMemoryStore", "-sampleRegion", "DE"], screens: result.screens,
  outDir: `${dir}/replay/de`,
  repair: { provider: "spark" },   // or "open"; references and flow.repaired.json come from the run directory
  runDir: dir,                     // optional: found above outDir when it has exploration.json
  onStep, signal, settle });
// replay.screenshots[i]: { name, png, verified, checks, repaired?, capture?, scrolledToTop? }
// replay.steps[i].via: id | structure | label | repair | fallback | point; replay.repairs, replay.repairCostUsd
// replay.aborted?, replay.repairedFlow?, replay.repairedFlowFile?, replay.patches?

const judged = await judgeScreens({ screens: [{ name, png, why }], appName: "Renew" });
```

## Files

- `packages/agent/src/runner/`: `index.ts` (ensureRunner), `driver.ts` (RunnerDriver),
  `process.ts` (build, cache, start, restart), `http.ts`, `simctl.ts`, `stable.ts`, `errors.ts`,
  `exec.ts`.
- `packages/explorer/`:
  - `src/explore.ts`, `observe.ts`, `actions.ts` (selectors and step executors shared by
    exploration and replay), `tools.ts`, `recorder.ts`, `replay.ts`, `repair.ts`, `judge.ts`, `json.ts`
  - since Oct 28 evening: `capture.ts` (capture settling), `scroll.ts` (list scroll state,
    scroll to top), `repaired.ts` (flow.repaired.json), `abort.ts`
  - `src/providers/` (`muse-responses.ts`, `chat.ts`, `pricing.ts`, `types.ts`)
  - `scripts/cli.ts`
- Scratchpad (not committed): `runs/{spark-v1,spark,spark-b,spark-c,wonder,open,open-json,smoke-open}/`,
  `sheet-picks.jpg`, `sheet-locales.jpg`, `probe/` (API probes, hang test, token measurement).
- Scratchpad, Oct 28 afternoon:
  - `runs/spark-63/`: the exploration, plus `flow-legacy.json`, `flow-broken.json`, and
    `replay/`, `replay-legacy-spark/`, `replay-legacy-open/`, `replay-broken/`;
  - `runs/spark-c/replay-63-repair/`;
  - `sheet-structural-locales.jpg`, `sheet-repair-spark-locales.jpg`,
    `sheet-repair-open-locales.jpg`, `sheet-screen-repair.jpg`, `repair-reference-all.jpg`;
  - `probe2/`: tree dumps, resolver test, sheet and strip scripts.
- Scratchpad, Oct 28 evening:
  - `runs/spark-settle/`, `runs/spark-settle2/` (explorations; `spark-settle2/replay/` is the
    5-locale matrix), `runs/spark-63/replay-settle-old/`, `runs/spark-63/replay-autorepair/`,
    `runs/spark-63/flow.repaired.json`;
  - `sheet-settle-locales.jpg`;
  - `probe3/`: launch-latency probes (`launch-latency.ts`, `launch-ab.ts`, `launch-new.ts`),
    `scrolltop.ts`, `api-test.ts`, os_log and `sample` output, strips.
