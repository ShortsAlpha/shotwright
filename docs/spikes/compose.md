# Spike: compose in the site, captions per market, theme from the icon, zip export (Oct 28)

The 1:50 and 2:30 beats of the demo: after Explore and Replay, the user composes the final
screenshots in the browser, edits a caption, and downloads one upload-ready zip.

Machine: Apple M2, 8 GB RAM, Node 24.15. Real input: the two Renew runs from Oct 28
(`7bbbf5…/runs/20261028-162758-63s0` and `O2ep…/runs/20261028-163847-6x72`, 1206×2622 captures,
en/de/ja replays, judge captions), copied to the scratchpad so the originals stay untouched.
Renew's icon was read from its asset catalog (read-only).

## Summary

| Question | Result |
|---|---|
| Captions per market | **One Muse Spark Open call per run** (`reasoning_effort: low`, JSON schema), 5.7–11.5 s for 6 screens × 3 locales; a second call only repairs captions that break a rule. Native rewrites, not translations (de "Alle Abos auf einen Blick", ja "月々の支出をひと目で把握"). 8 locales incl. Arabic, Korean, Chinese and Turkish in one call: 10.9 s. |
| Theme from the icon | Agent method `app.icon` finds the largest light-mode PNG in `AppIcon*.appiconset` (Renew: `AppIcon-1024.png`, 165 ms). `themeFromIcon` → blue gradient `#2666c9 → #15386f`, white caption, orange accent `#e8843b`. Saved as `icon.png` + `theme.json`; editable in the UI. |
| Render | Shared Chromium for the server (`renderShared`). 18 images: 4.3 s cold (browser start included), 1.5–2.0 s warm. One edited caption re-renders one image: 180 ms warm. |
| Re-render only what changed | Every image keeps a hash of its inputs (set, template, frame, theme, caption, position, capture file). Editing one caption: 1 rendered, 17 up to date. |
| Zip | `<app>-screenshots.zip`: `README.txt` + `screenshots/<asc-locale>/<nn>_iPhone63_<screen>.png`. 18 files, 13 MB, built in 43–73 ms. `unzip -t` passes; `sips`: 18 × 1206×2622, `hasAlpha: no`. |
| UI end to end (fake mode) | Explore → replay → compose → edit captions (en, de, ja) → template, theme and frame changes → download, in the built-in browser. Cancel and restart verified over the socket. |
| Limits | Explore: 3 per session per rolling hour, plus a daily cap for the whole server (`SHOTWRIGHT_DAILY_EXPLORE_CAP`, default 50). Captions: 10 per session per hour, 200 per day. Enforced on the server with clear messages; the page shows what is left. |
| Duo handoff | Agent method `duo.state`: captures `--display=3` and checks whether it is black (decoder in the agent, no image library). Project panel badge "Folded / Unfolded" + Check + the Device Hub hint. |

Contact sheets (scratchpad): `compose-sheet-run1-caption-top.jpg`, `compose-sheet-run2-caption-top.jpg`,
`compose-sheet-run2-panorama.jpg`, `compose-sheet-run2-bleed.jpg`, `compose-sheet-run2-caption-top-frameless-custom.jpg`.

## How to run

```sh
npm run dev                                    # site on :3000 (keys from .env.local)
npm run agent -- connect                       # on the Mac; pair on the site
# Explore → Replay in N languages → "Compose N screenshots" → edit captions → Download zip

# Without Xcode or keys:
SHOTWRIGHT_FAKE_MODELS=1 npm run dev
npm run agent -- connect --fake
```

The pure server path, for scripts (what the job runs):

```ts
import { composeRun, exportZip, loadCompose, setCaption } from "apps/web/lib/compose/compose.ts";
import { museCaptionWriter } from "apps/web/lib/compose/captions.ts";

await composeRun(runDir, { captionWriter: museCaptionWriter({ reasoningEffort: "low" }), icon: async () => pngBytes });
await setCaption(runDir, "de", "home-overview", "Alle Abos *auf einen Blick*");
await composeRun(runDir);                       // renders 1 image
const zip = await exportZip(runDir);            // { file, name, entries, bytes, files }
```

## Design

```
Browser ──job "compose" { settings }──► SessionJobs.startCompose ──► composeRun(runDir)
        ◄─ started / phase / compose / render / progress / ended (JobEvents) ─┘    │
                                                                                     ├─ captions: CaptionWriter (Spark Open, 1 call) ─► captions.json
        ──job "caption" { locale, screen, text }──► setCaption → compose (1 image)  ├─ theme: agent app.icon → themeFromIcon ──────► icon.png, theme.json
        ──job "preview" { settings }──► renderPreviews (3 small JPEGs)              └─ render changed images (renderShared) ───────► renders/…, compose.json
        ──GET /api/runs/<runId>/zip──► exportZip: composeRun (no models) → writeDeliverFolder + README → zipDirectory → stream
```

- **One job per session, cancellable.** Compose is a job kind next to explore and replay, so the
  existing job snapshot, events, Stop button and "one job at a time" rule apply. Compose needs no
  simulator: it does not lock the live view or the device list, and it starts without the agent
  (the icon is then read on a later compose).
- **Restart instead of refuse.** A settings change or a caption edit while a compose job runs
  cancels it, waits until it has unwound, and starts a new one. Finished images are kept (hash
  cache), so a restart only renders what is left. While a replay runs, edits are saved and the image
  shows "Outdated" until the next compose.
- **Cancellation** is checked between images; the image in flight on the other page finishes
  first (`Promise.allSettled`), so a cancelled run never writes after the run lock is released.
  (The first version used `Promise.all` and let a stale render land after the next job had started;
  the socket test caught it.)
- **Run lock.** `withRunLock(runDir)` serializes everything that writes a run folder: compose jobs,
  caption edits and the zip route.
- **Shared renderer.** `lib/compose/renderer.ts` starts one Chromium on first use (2 pages) for all
  sessions and closes it after 5 idle minutes (`SHOTWRIGHT_RENDERER_IDLE_MS`) and on server shutdown;
  if the browser dies it is restarted once.
- **Manifest.** The job manager rebuilds `manifest.json` after every replay; `withComposeInfo` adds
  the captions per screen and locale, the rendered files per set and locale, and `files.captions`,
  `theme`, `icon`, `compose`, so nothing is lost when a locale is replayed again.

### Data model (sets)

`ComposeView.renders` is `set → locale → screenshots`, and `sets[]` lists each set with its size and
locales. Today a run explores one device, so `captureSets()` returns one set: the explored device's
(`manifest.device.setId`, else guessed from the screen size; a fake run on the Duo entry produced
1398×2034 Duo outer renders). When replays per device exist (iPad 13", Duo outer and inner),
`captureSets` returns one entry per set and the gallery shows a set switcher; templates, frames and
the deliver labels already cover all four sets. Until a locale is replayed, the exploration's own
screenshots stand in for its locale, so compose works right after Explore.

### Run folder

```
captions.json   { locales: { de: { "home-overview": { text, source: "muse"|"edited", original? } } }, calls: [...] }
icon.png        the app icon as found on the Mac
theme.json      { source: "icon"|"default", colors, dark, light }   (editable ThemeSettings)
compose.json    { settings: { template, frame, theme|null }, renders: { set: { locale: { screen: { position, file, thumb, hash, caption, ms, warnings, captionScale } } } } }
renders/iphone-6.3/de/01_home-overview.png          exact size, no alpha
renders/iphone-6.3/de/thumbs/01_home-overview.jpg   360 px
export/deliver/…, export/Renew-screenshots.zip
```

`settings.theme: null` means "the suggested theme" (from the icon), so an icon read later applies
on its own; the first color edit copies it into the settings. Edited captions keep the Muse
`original`, so "Reset" brings it back without a model call. Captions not yet written fall back to
the judge's English caption (marked "English" in the UI).

## Captions

### Prompt

System: *"You are a senior App Store localization copywriter. You transcreate the marketing captions
shown above App Store screenshots: for every market you write the caption a native copywriter there
would write, keeping the benefit of the English draft but never translating it word for word."*

User (Renew run 2, abridged):

```
App: Renew, A subscription tracker.

Screenshots in App Store order (the first three appear in search results):
1. home-overview
   English draft: "Your monthly spend at a glance"
   The screen shows: Hero overview with monthly spend, upcoming renewals and recognizable subscription brands.
…
Write one caption per screenshot for each locale:
- en: English, United States, at most 30 characters and 6 words
- de: German, Germany, at most 30 characters and 6 words
- ja: Japanese, Japan, at most 16 characters

Rules:
- Benefit-led: say what the user gets, not what the screen is.
- Native: idiomatic App Store copy for that market. Rephrase freely; keep the meaning.
- Use the words local apps use for product concepts, not anglicisms or literal translations (a free trial is "Probeabo" or "Testphase" in German, "無料体験" in Japanese).
- Short: stay within the limit given for the locale (count characters, spaces included).
- Grammatical, complete phrases: never drop particles or articles to save characters (Japanese keeps を, が, に); pick shorter words instead. No slang or clipped words ("subs").
- Sentence case: capitalize only the first word and words the language always capitalizes (German nouns, proper names).
- No app name, no quotes, no emoji, no trailing period (no 。 either).
- Japanese and Chinese: no spaces between words. Arabic and Hebrew: write in the script itself, right to left.
- Every caption in one locale must be different from the others.
- en: keep the English draft if it follows these rules; otherwise improve it.
- In every caption, wrap the key benefit (one to four words, e.g. *at a glance*) in *asterisks*; it is drawn in the accent color. Exactly one marked run per caption, never the whole caption.

Answer with JSON only: {"captions":[{"screen":"<name>","locale":"<code>","text":"<caption>"}]}, …
```

`response_format` is a JSON schema with `screen` and `locale` as enums (fallback to the plain prompt
on HTTP 400, as the judge does). The answer is cleaned (quotes, trailing `.`/`。`, unbalanced or
whole-caption `*` removed) and checked (`captionIssues`): length in graphemes without the `*` marks
(Latin/Cyrillic/Greek/Arabic 30 characters and 6 words, ja/zh 16, ko 18, th 24), trailing period,
the app name as a word of its own ("Renew" but not "renewal"; the first version flagged "renewal"
and triggered needless repair calls), duplicates within a locale. Missing or failing captions get
one repair call listing exactly those; what still fails is kept and flagged in the UI.

Iterations: the judge's per-screen reason ("near-duplicate, redundant in the set") is ranking
commentary and was dropped from the prompt (only the explorer's description of the screen is sent).
Default reasoning took 41 s and 14k reasoning tokens for no better copy (it wrote "Jedes Abo und
jeder Test", "Test" for a trial); `low` takes 6–12 s. Japanese at a 14-character limit dropped
particles ("無料体験損せず解約"); 16 plus the grammar rule fixed that. Optional emphasis was used
sporadically, which looked inconsistent across a set; "one marked run in every caption" is consistent.
Text only, no images: the captions come from the draft and the screen description, which keeps the
call fast. Sending the localized replay screenshots would let the model reuse the app's own terms
(worth trying if terminology drifts).

### Samples (Spark Open, `low`, the runs as composed)

| Screen (run 1) | en | de | ja |
|---|---|---|---|
| home-overview | See everything *in one place* | Alle Abos *auf einen Blick* | サブスクを*ひと目で*管理 |
| all-subscriptions | Every trial *under control* | Probeabos *im Griff* behalten | 体験も費用も*逃さず管理* |
| insights-spend-chart | See where money *really goes* | Ausgaben *klar verstehen* | お金の流れを*すっきり把握* |
| calendar-renewals | Never miss *a renewal* again | Termine *nie mehr verpassen* | 更新日を*逃さず通知* |
| subscription-detail-netflix | *Smart reminders* for renewals | Abos *smart verlängern* lassen | 更新を*賢くリマインド* |
| trial-detail-disney | Stop trials *before you pay* | Probeabos *vor Kosten* beenden | 無料体験を*払う前に解約* |

| Screen (run 2) | en | de | ja |
|---|---|---|---|
| home-overview | Your monthly spend *at a glance* | Monatskosten *auf einen Blick* | 月々の支出を*ひと目で把握* |
| insights-spend | See *where your money goes* | Behalte *Ausgaben im Griff* | お金の流れを*しっかり把握* |
| calendar-month | See every due date *on calendar* | Alle Fälligkeiten *im Kalender* | 支払日を*カレンダーで管理* |
| subscriptions-all | View *all subscriptions* at once | *Alle Abos* an einem Ort | すべての契約を*一覧で管理* |
| insights-yearly | Forecast *a year of spending* | Jahresausgaben *vorausschauen* | 年間支出を*先まで予測* |
| subscription-detail | *Never miss* a payment reminder | Keine Zahlung *mehr verpassen* | 支払いを*忘れずにお知らせ* |

All fit 2 lines at 93–100 % of the base caption size (no warnings in 36 renders). Weak spots:
"Abos smart verlängern lassen" misreads a reminder screen as auto-renewal; "See every due date on
calendar" is the judge's draft kept as is (missing "the"). The editor exists for these.

More markets in one call (run 2, 10.9 s, one Turkish caption at 31 characters repaired):

| | home-overview | insights-spend | subscriptions-all |
|---|---|---|---|
| fr | Dépenses *en un clin d'œil* | Voyez *où part votre argent* | Abonnements *tous ensemble* |
| ko | *한눈에* 보는 월 지출 | *돈의 흐름*을 확인해요 | 모든 구독을 *한곳에서* |
| zh-Hans | *一目了然*看月度开销 | 看清*钱花在哪*了 | 全部订阅*一处管理* |
| tr | Aylık gider *bir bakışta* | Paranın *nereye gittiğini* gör | Tüm abonelikler *tek bir yerde* |
| ar | شاهد مصاريفك *بنظرة واحدة* | اعرف *أين يذهب مالك* | كل اشتراكاتك *في مكان واحد* |

## Theme

`app.icon` walks the project's folder (the .xcodeproj's parent) breadth first, up to depth 8 and
20k folders, skipping `DerivedData`, `.build`, `node_modules`, `Pods`, `Carthage`, `build`, `.git`
and hidden folders, and collects `AppIcon*.appiconset`. Images marked dark or tinted in
`Contents.json` (or named `-dark`/`-tinted`) rank last; then the exact name `AppIcon.appiconset`,
then pixel area, then depth. Renew's set has `AppIcon-1024-dark.png` as the largest *file*, so
"largest" means largest light image. Icon Composer `.icon` files (Xcode 26+) are not read yet: the
default theme is used.

On the server `saveTheme` runs `themeFromIcon` in dark and light mode: the dark one is the default
suggestion, the light one is a preset. The user can change the gradient stops, caption and accent
colors (click an icon color to use it as the accent), device color (graphite/silver), or reset to
the icon theme.

## UI

The "Screenshots" panel appears under Languages once a run has captures:

- Header: captions model and time, set and size, rendered count; "Compose N screenshots" /
  "Update N screenshots" / "Up to date"; "Download zip" (enabled once everything is rendered);
  progress bar and Stop while composing.
- Left: template picker with a live preview of the first screen in each template (server-rendered
  216 px JPEGs, debounced 250 ms, cached), theme editor, frame (Device / Frameless / Raw).
- Right: locale tabs with done counts and a dot when a caption breaks a rule; the gallery in App
  Store order with position badges (top 3 highlighted), "Outdated", spinner, failure and a badge
  when a caption was shrunk below 75 %. Under each image an inline caption editor: Enter saves and
  re-renders that image, Escape reverts, character count against the locale's limit, rule issues,
  source badge (Muse / Judge / English / Edited) and Reset. "Rewrite captions" asks Muse again for
  every caption not edited by hand.
- Project panel: explore quota line; for a Duo simulator the fold badge, Check, and the Device Hub hint.

## Zip

```
Renew-screenshots.zip
  README.txt
  screenshots/de-DE/01_iPhone63_home-overview.png … 06_iPhone63_trial-detail-disney.png
  screenshots/en-US/01_iPhone63_home-overview.png …
  screenshots/ja/01_iPhone63_home-overview.png …
```

README.txt (from run 1):

```
Renew: App Store screenshots
Made with Shotwright (https://github.com/ShortsAlpha/shotwright) on 2026-10-28, run 20261028-162758-63s0.

CONTENTS
  18 screenshots in 3 languages: PNG, sRGB, no alpha, exact App Store sizes.
  iPhone 6.3" (1206 x 2622), file label "iPhone63", 6 per language
  screenshots/<App Store Connect locale>/<nn>_<set>_<screen>.png   (nn = order on the product page)

UPLOAD WITH FASTLANE DELIVER (from the folder this file is in)
  fastlane deliver --app_identifier yadaumur.Subscription-Tracker --screenshots_path ./screenshots --skip_binary_upload --skip_metadata --overwrite_screenshots --force
  …
LANGUAGES (Shotwright -> App Store Connect folder)
  en       -> en-US    English (U.S.)
  de       -> de-DE    German
  ja       -> ja       Japanese

CAPTIONS
  en       01  home-overview                  See everything in one place
  …
```

The route renders stale images first (no model calls; missing captions fall back to English) and
refuses with 409 if any image fails. It only serves runs of the cookie's session.

## Limits

| Env | Default | Meaning |
|---|---|---|
| `SHOTWRIGHT_SESSION_EXPLORE_PER_HOUR` | 3 | Explorations per session in any rolling hour |
| `SHOTWRIGHT_DAILY_EXPLORE_CAP` | 50 | Explorations per UTC day for the whole server; `0` turns Explore off |
| `SHOTWRIGHT_SESSION_CAPTIONS_PER_HOUR` | 10 | Caption calls (compose or "Rewrite captions") per session per hour |
| `SHOTWRIGHT_DAILY_CAPTIONS_CAP` | 200 | Caption calls per UTC day for the server |
| `SHOTWRIGHT_RENDERER_IDLE_MS` | 300000 | Idle time before the shared Chromium closes |

Daily counters persist in `<data>/limits.json`; per-session windows live in memory (sessions do
too). Messages, e.g. *"You have used the 2 explorations this session gets per hour. The next one is
available in 54 min."* and *"This server has reached today's limit of 50 explorations, which keeps
the public demo within its model budget. It resets at midnight UTC (in 6 h); run Shotwright yourself
to go on now."* When the caption quota is used up during compose, compose goes on with the English
captions and logs why. Rendering, previews and the zip never call a model. Fake mode counts too, so
the limits can be tried without keys. The per-session limit can be sidestepped by pairing again
(each pairing needs a running agent); the daily cap is the real backstop.

## Duo handoff

`duo.state { udid } → { unfolded }`: `xcrun simctl io <udid> screenshot --type=png --display=3`, then
`litShare` (a small PNG decoder in `packages/agent/src/png.ts`: 8-bit grey/RGB/RGBA, all filters)
counts pixels brighter than 24 on a 4-pixel grid; unfolded when more than 0.2 % are lit. Checked on
synthetic 2007×2853 RGBA PNGs (black: off; black with a lit 60×20 status-bar patch: off) and a real
capture (on), 240 ms for the 2007×2853 decode. Not run against a real Duo today (no simulator use).
With `--fake` the first check reports folded and later ones unfolded.

## Verification

| What | Where | Result |
|---|---|---|
| `composeRun` + captions + theme + zip on both real runs | `scratchpad/compose/compose-real.mts` on copies of the run folders | 18 + 18 images, zips listed and tested, sizes and alpha checked with `sips`, contact sheets reviewed |
| Caption edit → one re-render; reset to the Muse original | `scratchpad/compose/edit-and-templates.mts` | 1 rendered, 17 up to date, 180 ms warm |
| Templates, frameless, custom light theme | same script, contact sheets | correct; panorama ribbons join across the set |
| Cancel waits for the in-flight render | `scratchpad/compose/cancel-race.mts` | first run rejects after both renders landed; second renders the 2 changed images |
| UI end to end, fake mode | `SHOTWRIGHT_FAKE_MODELS=1 PORT=3100 npm run dev` + `connect --fake`, built-in browser at 1440×1000 | explore → replay → compose (15) → caption edits en/de/ja → Bleed → Light theme → download (200, `application/zip`, `FakeApp-screenshots.zip`); README carried the edited captions; reload restored the panel |
| Cancel and restart over the socket | page script against the server | `started → cancelling → ended:cancelled → started → … → ended:done`, no events after `ended` |
| Explore quota | UI (limit 2) and a direct socket message | button disabled with the message; server answers `{ code: "quota" }` |
| Duo badge | fake agent, Duo entry connected | Folded, then Unfolded after Check; hint shown |
| Duo outer set | fake explore on the Duo entry | 1398×2034 renders, gallery uses the set's aspect ratio |
| `npm run typecheck` | whole repo | passes |

Found on the way: under `tsx` (how the web server runs) esbuild's `keepNames` wraps named inner
functions in `__name(...)`, and the renderer's `page.evaluate(renderInPage)` then threw
"__name is not defined" in the page, so every render failed. The render spike ran under plain Node
and never hit it. Fixed in `packages/render/src/renderer.ts` with a no-op `__name` in the page shell.

## Timings

| Step | Time |
|---|---|
| Captions, 6 screens × 3 locales (Spark Open, low) | 5.7–11.5 s (1 call; +~4 s when a repair call runs) |
| Captions, 6 × 8 locales | 10.9 s |
| `app.icon` on Renew (walk + read) | 165 ms |
| `themeFromIcon` dark + light, save | ~80 ms |
| 18 renders, cold (Chromium start included) | 4.3 s |
| 18 renders, warm (2 pages) | 1.5–2.0 s (85–110 ms wall per image; 140–650 ms per image in flight, thumbnail included) |
| One caption edit | 180 ms warm, 780 ms cold |
| Template previews (3 × first screen) | ~0.6 s uncached |
| Zip, 18 PNGs (13 MB) | 43–73 ms |
| Fake-mode compose in the site, 15 images incl. stub captions (1.2 s) | 3.9–4.1 s |

## Known limitations and next steps

- Compose works on the session's current exploration (kept in memory, like sessions). After a
  server restart the run folders are still on disk, but a new session does not load them. Demo
  mode needs a loader; `loadCompose(runDir)` and `composeRun(runDir)` are already independent of
  sessions.
- Only one set per run until replays per device exist (iPad 13", Duo inner); see Data model.
- No screen selection or reordering in the gallery (App Store order = the judge's ranking, max 10).
- Captions: the model occasionally rewrites an English draft that already follows the rules, and
  terminology can drift (see samples). Rule checks are advisory: a caption that still breaks a rule
  after the repair call renders (shrunk if needed) and is flagged.
- The zip route renders stale images without job events; the page refreshes its view after the
  download. App previews are not in the zip yet.
- `.env.example` does not list the new variables yet (outside this change); they are in the table above.

## Files

```
apps/web/lib/compose/state.ts      client-safe types: settings, ComposeView, caption rules (captionIssues, captionLimit)
apps/web/lib/compose/captions.ts   CaptionWriter: Spark Open transcreation + repair, cleaning, fake writer
apps/web/lib/compose/compose.ts    composeRun, loadCompose, setCaption, renderPreviews, exportZip, withComposeInfo, run lock
apps/web/lib/compose/renderer.ts   shared Chromium (renderShared, closeRenderer)
apps/web/lib/limits.ts             quotas (explore, captions), limits.json
apps/web/lib/jobs/manager.ts       compose job, caption edits, previews, explore quota, manifest merge
apps/web/lib/jobs/state.ts         compose job kind, phases, events (compose, render, caption, progress)
apps/web/server.ts                 GET /api/runs/<runId>/zip; renderer closed on shutdown
apps/web/app/session/compose-panel.tsx   Screenshots panel
apps/web/app/session/project-panel.tsx   Duo fold badge, explore quota line
packages/core/src/protocol.ts      app.icon, duo.state (additive)
packages/agent/src/icon.ts         findAppIcon
packages/agent/src/duo.ts          duoState, innerDisplayOn
packages/agent/src/png.ts          decodePng, litShare
packages/render/src/renderer.ts    __name shim for callers under tsx
```
