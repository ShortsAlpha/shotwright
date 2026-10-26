# Shotwright

An AI agent that drives your iOS app in the Simulator and turns real captures into App Store–ready screenshots, preview videos and header/search assets, for every device and every language.

> Built during the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026), Indie track, theme *Build for Your World*.
> Everything in this repository was written during the event; the commit history is the record. The iOS apps used in the demo are pre-existing apps used only as input.

## The problem

Every release, an iOS developer needs up to 10 screenshots per device set (iPhone, iPad, iPhone Duo outer and inner displays, Apple Watch), per App Store locale (~40), plus app previews and, since October 2026, product page header and search-results assets. iPhone Duo screenshots become mandatory in April 2027. That is thousands of assets, produced by hand.

## How it works

1. **Connect** a small agent on your Mac; it builds your Xcode project for the Simulator. Your source code never leaves your machine.
2. **Explore** — a Muse model navigates the app, picks the most marketable screens and records the path to each one.
3. **Replay** the recorded path deterministically for every device and locale, with a clean status bar.
4. **Compose** captions, frames and backgrounds; cut preview, header and search videos from real screen recordings.
5. **Validate** against Apple's specs and guidelines, then upload to App Store Connect.

The pixels of your app are always real captures. AI writes the copy, picks the screens and generates backgrounds — never the app UI.

## Meta models

| Model | Role |
|---|---|
| Muse Wonder / Muse Spark 1.3 | Exploration agent (computer use), screen ranking, captions, repair of broken replay steps, guideline checks |
| Muse Spark Open | Bulk transcreation of captions and store metadata into ~40 locales |
| Muse Image | Backgrounds and header scenes |
| SAM 3.1 | Tracking UI elements in recordings for zooms and highlights, PII blurring |
| Muse Voice Transcribe | Describe your app by voice; the transcript seeds the marketing copy |

## Status

Work in progress. See [PLAN.md](PLAN.md) for the build plan.

## License

[AGPL-3.0](LICENSE). If you run a modified version of Shotwright as a network service, you must make your source available to its users.
