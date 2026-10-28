# Shotwright build plan

Submission deadline: **Wed Nov 4, 21:00 ET** (Thu Nov 5, 05:00 Turkey time). Feature freeze: **Nov 3**.

## What judges see

Judged on the 3-minute demo video, the public repo and the live product (Indie track: creativity, technical ambition, whether it works). So:

- The end-to-end flow must work every time; reliability beats feature count.
- The website must be usable **without a Mac**: a demo project with real captures, where judges can change templates, add locales, generate header art and download assets.
- Judges with a Mac and Xcode can install the agent with one command and run it on their own app.
- Muse calls from the public site are rate-limited so judges cannot drain the credits.

## Architecture

```
Browser ──► Web app (Next.js, hosted) ──► Meta Model API / Baseten
                 ▲  WebSocket (agent dials out, no open ports)
                 │
            Mac agent (TypeScript CLI) ──► xcodebuild, simctl, UI driver
```

- **Web app**: projects, templates, rendering, Muse calls (keys stay server-side), zip export. Deployed as one long-lived Node process on Railway (Vercel's WebSocket beta pins each connection to one instance, so the agent and the browser could land on different ones).
- **Mac agent**: hands and eyes only — build, boot, install, launch, tap, screenshot, record. Decisions come from the server.
- **Input**: the developer's own Xcode project on their Mac (source never uploaded). Optional App Store URL to prefill name, icon, colors and locales via the iTunes Lookup API.
- **Demo data contract**: the app reads a `-ShotwrightDemo` launch argument and loads demo content; optional test account for login walls.

## Pipeline

1. **Build** for the Simulator (`xcodebuild -sdk iphonesimulator`).
2. **Explore** once with Muse: screenshot + accessibility tree in, action out. Rank screens by marketing value (first 3 matter most — they show in search).
3. **Record** the path to each chosen screen as accessibility-id steps (not coordinates).
4. **Replay** for every device × locale (`-AppleLanguages`, `-AppleLocale`, `simctl status_bar override` 9:41, appearance). If a step breaks, Muse repairs only that step.
5. **Compose**: captions, our own SVG device frames, backgrounds; text fitting, RTL, CJK fonts. Export at exact pixel sizes.
6. **Video**: `simctl io recordVideo` during replay → cut 15–30 s previews and 5–30 s header/search loops; SAM 3.1 drives zooms and highlights.
7. **Validate**: sizes, no alpha, video specs, guideline checks (2.3.3, 2.3.4, 2.3.14).
8. **Export** one upload-ready zip in the fastlane `deliver` layout (`screenshots/<locale>/<n>_<set>_<screen>.png`, previews alongside): drag into App Store Connect or run `fastlane deliver`. Direct upload through the App Store Connect API is post-hackathon.

## Meta models

| Model | ID | Role |
|---|---|---|
| Muse Spark 1.3 | `muse-spark-1.3` | Default: exploration, ranking, captions, repair, checks |
| Muse Wonder | `muse-wonder-1.0` | Hard exploration only (computer use; ~3–4× Spark cost) |
| Muse Spark Open | `meta-models/muse-spark-open-1026` (Baseten) | Bulk transcreation into ~40 locales |
| Muse Image | `muse-image-1.0` | Backgrounds, header scenes — never app UI |
| SAM 3.1 | `sam-3.1` | Element tracking in recordings, PII blurring |
| Muse Voice Transcribe | `muse-voice-transcribe-1.0` | Voice brief → marketing copy |

Budget: $150 Meta credit. Estimated $3–6 per full app run; replays cost ~$0.

## App Store asset matrix

| Set | Size (portrait) |
|---|---|
| iPhone 6.3" (Apple's required iPhone set) | 1206 × 2622 |
| iPad 13" | 2064 × 2752 |
| iPhone Duo outer | 1398 × 2034 |
| iPhone Duo inner | 2007 × 2853 (mandatory from April 2027, iOS 27.1 SDK) |
| Product page header | 3840 × 1646 (21:9), image or 5–30 s video |
| Search results | 3:2, 1920 × 1280 – 3840 × 2560, image or video (always muted) |
| App preview | 15–30 s, up to 3 per set |

## Schedule

| Date | Work |
|---|---|
| Oct 26–27 | ✅ Spikes ([simulator](docs/spikes/simulator.md), [Muse API](docs/spikes/muse-api.md)): locale, status bar, alpha, video, Duo displays, own XCUITest runner, first Muse call. Monorepo skeleton. Still open: manual Duo unfold handoff, Spark 1.3 vs Wonder. |
| Oct 28 | ✅ Mac agent ↔ web over WebSocket, pairing code, live simulator view with click-to-tap (verified end to end on the real runner). ✅ Exploration agent → recorded flow → replay per locale, screen judge on Spark Open ([explorer spike](docs/spikes/explorer.md)). Spark 1.3 is the default explorer (~$0.05/run). |
| Oct 29 (done Oct 28) | ✅ Structural selectors + Muse step repair: Renew replays 6/6 in en/de/ja/ar/tr with no model calls; broken steps repaired 8/8 ([explorer spike](docs/spikes/explorer.md)). ✅ Explore and Replay from the site with live step feed, picks, judge, per-locale progress; artifacts per session in `.shotwright/sessions/` (`manifest.json`). ✅ Renderer ([render spike](docs/spikes/render.md)): 3 templates, own SVG frames, OFL fonts, RTL/CJK, exact sizes, deliver export + zip, ~190 ms per iPhone image. |
| Oct 29 | Wire render + zip export into the site (from `manifest.json`); capture settling (the "all-subscriptions" screen was captured mid title animation; first `/source` after launch takes 30–55 s); Duo unfold handoff in the UI; replay in the site should use step repair; per-session rate limit on Explore for the public site |
| Oct 30 | Replay across devices × locales, step repair |
| Oct 31 | Renderer: templates, SVG frames, captions, text fitting, RTL, exact-size export |
| Nov 1 | Localization (Spark Open), store metadata, demo mode on the site |
| Nov 2 | Preview + header/search videos, SAM 3.1 zooms, Muse Image backgrounds, validator. If time permits: narrated previews per locale (Spark Open writes, ElevenLabs reads) |
| Nov 3 | Railway deploy, zip export polish, **feature freeze**, full rehearsal |
| Nov 4 | 3-minute demo video, README, submit |

## Demo video (3 min)

| Time | Beat |
|---|---|
| 0:00 | The problem: 4 sets × 10 screenshots × 40 locales, Duo mandatory in April 2027 |
| 0:20 | Connect the Mac; the agent explores the app live and explains its picks |
| 1:10 | Replay across devices and locales (time-lapse), Duo outer and inner sets |
| 1:50 | Output: screenshots, preview, header/search video; edit a caption, re-render |
| 2:30 | Download the zip, drop it into App Store Connect |
| 2:50 | What was built during the hackathon, which Meta models do what |

Narration: script written by us, voiced with ElevenLabs.

## Hackathon rules checklist

- [ ] Repo is public; no secrets in history (`.env.local`, `.p8` are ignored)
- [ ] Only work built during the event is demoed, and it is clearly marked
- [ ] No assets without rights: own SVG device frames (no Apple bezels), OFL fonts, licensed or no music
- [ ] Demo video is 3 minutes and its link is public
- [ ] Live product link works without a Mac

## Risks

| Risk | Mitigation |
|---|---|
| 8 GB RAM Mac | One simulator at a time; render on the server |
| UI driver | Resolved: our own XCUITest runner (`ios/ShotwrightRunner`), no idb or WebDriverAgent. Needs per-request timeouts and restart on hang. |
| Login walls, paywalls, empty states | Demo launch argument, test account, deep links |
| Duo inner display: no programmatic unfold | Verified Oct 28: developer unfolds once per boot in Device Hub; the state survives app relaunches and locale changes, and rotation gives portrait 2007×2853. Automate everything after that step. |
| Apps with their own language setting ignore `-AppleLanguages` | Reinstall per locale or use the app's own launch argument |
| No accessibility identifiers in real apps | Structural selectors; Muse repair as fallback |
| Slow launches (5–25 s) on 8 GB | Capture several screens per launch; launch once per locale |
| Judges without a Mac | Demo mode on the site |
| Credits drained by public site | Rate limits, cached results |
