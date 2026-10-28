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
8. **The flow schema needed workarounds** (packages/core, not changed; see below).
9. **Disk full.** The Mac's data volume reached 100 % (583 MB free) during a replay, and one
   replay failed with `ENOSPC`. I deleted my own build intermediates (Renew DerivedData except
   `Build/Products`, the runner's index), leaving 1.5 GB free. The simulator device folder alone
   is 3.5 GB. Watch this before long replay batches.

## Proposed changes to `packages/core/src/flow.ts` (not made; core is owned elsewhere)

- **`ElementSelector`: add optional `type` and `index`.** The runner already supports both.
  Today a repeated identifier is disambiguated by adding the label (localized) or by the element
  nearest the fallback point.
- **`TapStep`: allow a coordinate-only target.** The schema requires an id or label. A `tap_at`
  on an unlabelled area is recorded against the smallest labelled element under the point, or
  left out of the flow with a warning.
- **`ScreenshotStep`: optional `expect` (stable identifiers plus structure signature).** Then a
  flow file alone can verify itself in other locales. Today this lives in `exploration.json`
  (`screens`) and must be passed to `replayFlow`.
- **`SwipeStep`: optional start point.** Swipes are always centred on the target or the screen.

## Runner module API (for the WebSocket agent)

```ts
import { ensureRunner, RunnerDriver, RunnerRestartedError } from "./runner/index.ts";

const handle = await ensureRunner({
  udid,                     // required
  port?,                    // default 8615
  derivedDataPath?,         // default ~/Library/Caches/Shotwright/runner/xcode-<version>-<build>
  boot?,                    // default true: boots the simulator if it is shut down
  forceRebuild?, projectDir?, healthTimeoutMs?, // default 300 s
  driver?: { timeouts?, settleAfterActions?, settle? },
  log?: (message) => void,
});
handle.driver   // RunnerDriver implements DeviceDriver
handle.screen   // ScreenInfo in points, e.g. { width: 440, height: 956, currentBundleId }
handle.process  // RunnerProcess: restart(), stop(), healthy(), logPath, owned
await handle.stop();        // POST /shutdown, then kills xcodebuild if needed
```

- `RunnerDriver` covers all of `DeviceDriver`. Each call settles on its own: `launch` waits for
  1.5 s of layout stability, and actions wait for two equal snapshots.
- Extras:
  - `waitForStable({ bundleId?, timeoutMs?, minStableMs? })` returns the snapshot plus
    `stable` and `waitedMs`;
  - `health()`;
  - `launchViaRunner()` uses XCUI `launch()`; avoid it right after an install.
- On a hang the driver restarts the runner by itself. Don't recreate the driver because one call
  timed out:
  - reads are retried once;
  - actions throw `RunnerRestartedError`, after which you observe again.
- Timeouts (ms), overridable: health 3,000, source 30,000, screenshot 10,000, tap 20,000,
  swipe 15,000, type 30,000, home 10,000, launch 90,000, hang check 15,000.
- Also exported: `simctl` (`installApp`, `launchApp`, `terminateApp`, `bootAndWait`,
  `listDevices`), `layoutHash`, `findFrame`, and the error classes.
- The explorer runs against any `DeviceDriver`. It uses `waitForStable` when the driver has it
  and otherwise polls `source()`, so the WebSocket driver needs nothing extra.

## Explorer API

```ts
import { explore, replayFlow, judgeScreens, createProvider } from "@shotwright/explorer";

const result = await explore({ driver, provider: createProvider("spark", { reasoningEffort: "low" }),
  bundleId, launchArgs, appName: "Renew", hint, maxSteps: 40, maxCostUsd: 1, outDir, log,
  onEvent }); // events: observation (with JPEG), turn, action (with the model's reason), mark (with PNG)
// result: flow, screens, ranked, notes, usage, costUsd, timing, steps, graph, verification

const replay = await replayFlow(driver, result.flow, { locale: { language: "de" },
  launchArgs: ["-seedSampleData", "-inMemoryStore", "-sampleRegion", "DE"], screens: result.screens });
// replay.screenshots[i]: { name, png, verified, checks }

const judged = await judgeScreens({ screens: [{ name, png, why }], appName: "Renew" });
```

## Files

- `packages/agent/src/runner/`: `index.ts` (ensureRunner), `driver.ts` (RunnerDriver),
  `process.ts` (build, cache, start, restart), `http.ts`, `simctl.ts`, `stable.ts`, `errors.ts`,
  `exec.ts`.
- `packages/explorer/`:
  - `src/explore.ts`, `observe.ts`, `actions.ts` (selectors and step executors shared by
    exploration and replay), `tools.ts`, `recorder.ts`, `replay.ts`, `judge.ts`, `json.ts`
  - `src/providers/` (`muse-responses.ts`, `chat.ts`, `pricing.ts`, `types.ts`)
  - `scripts/cli.ts`
- Scratchpad (not committed): `runs/{spark-v1,spark,spark-b,spark-c,wonder,open,open-json,smoke-open}/`,
  `sheet-picks.jpg`, `sheet-locales.jpg`, `probe/` (API probes, hang test, token measurement).
