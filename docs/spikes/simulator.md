# Spike: iOS Simulator capture and UI driving (Oct 26–27)

Machine: Apple M2, 8 GB RAM, macOS 27.0.1, Xcode 27.1 (27A9275, iOS Simulator SDK 27.1),
ffmpeg 9.0.2. One simulator booted at a time; other agents and builds ran in parallel, so
timings vary by about 2x between runs. Ranges below are from several runs.

Devices used:

| Name | UDID | Model / runtime |
|---|---|---|
| Shotwright iPhone 6.9 | 93861348-64C1-4AF6-BA6C-41EB31FC73EF | iPhone 17 Pro Max, iOS 27.0 |
| Shotwright iPad 13 | 81A19D60-FEFC-4BAB-B7BD-9E9B5DA3198E | iPad Pro 13" (M5), iOS 27.0 (not used today) |
| Shotwright iPhone Duo | 5F9334B3-52D5-41DD-A7ED-D94D485D9101 | iPhone Duo, iOS 27.1 (27.1 runtime supports only the Duo) |

All captures and videos are in the session scratchpad, not in the repo.

## Summary

| Spike | Result |
|---|---|
| 1. Readiness, locale, alpha | Works. A fixed sleep is not enough, and frame stability alone is not either: apps show a stable blank screen for 4–10 s. Use the runner (launch, then wait until two `/source` snapshots match), or screenshot stability plus a non-blank check. de/ja/ar work; RTL confirmed. Flatten alpha with `ffmpeg -pix_fmt rgb24` (pixel-identical). Runner screenshots already have no alpha. |
| 2. Video | `recordVideo` is variable frame rate (frames only when something changes). The ffmpeg command below gives constant 30 fps H.264 High at 886×1920 with BT.709 tags and a silent AAC track. The video is tagged P3 but its pixels are sRGB: retag it, don't convert. |
| 3. iPhone Duo | Both displays enumerate and capture at Apple's exact sizes (outer 1398×2034 = `--display=1`, inner 2007×2853 = `--display=3`). The device boots folded, and the inner display stays black. **I found no way to unfold it from the command line or from XCTest.** Details and options are below. |
| 4. UI driver | **Works.** Our own XCUITest runner, `ios/ShotwrightRunner`, serves HTTP on 127.0.0.1:8615. No WebDriverAgent or idb needed. `/source` takes 70–290 ms, `/screenshot` 110–200 ms, a coordinate tap 0.4–1.5 s, a tap by identifier 0.7–0.9 s. |
| 5. Real app | DailyAffirmations builds unmodified in 69 s clean (5 s incremental). Signing needed no changes. Installed, launched and captured in de/ja/ar; tree dump works. The app stores its own language in app-group defaults, so switching locale needs a fresh install or the app's own launch argument. Its buttons have no accessibility identifiers. |

---

## 1. Readiness, locale, RTL, alpha

### Commands that worked

```sh
U=93861348-64C1-4AF6-BA6C-41EB31FC73EF
# clean status bar (charged/charging shows a bolt; discharging at 100 % does not)
xcrun simctl status_bar $U override --time 9:41 --batteryState discharging --batteryLevel 100 \
  --dataNetwork 5g --wifiBars 3 --cellularMode active --cellularBars 4 --operatorName ''
# get to the home screen first (see "back-link" gotcha), then launch in a locale
xcrun simctl terminate $U <foreground bundle id>
xcrun simctl launch --terminate-running-process $U com.apple.Preferences \
  -AppleLanguages "(ar)" -AppleLocale ar_SA
xcrun simctl io $U screenshot --type=png out.png            # 0.43 s, 1320x2868 RGBA
ffmpeg -v error -y -i out.png -pix_fmt rgb24 out_flat.png   # 0.2 s, RGB, sRGB profile kept
sips -g hasAlpha out_flat.png                               # hasAlpha: no
```

- Screenshot formats: png 0.43 s (360 KB), jpeg 0.47 s, tiff 0.56 s, bmp 1.17 s (15 MB).
- `screenshot -` does **not** write to stdout. It creates a file named `-`.
- The alpha channel is present but fully opaque (min = max = 255). So `-pix_fmt rgb24` is
  lossless: the `framemd5` of the RGB data is identical before and after. Alternatives:
  `sips -s format png` keeps the alpha; `sips -s format jpeg` drops it but is lossy; sips has
  no "remove alpha" option for PNG.
- The runner's `GET /screenshot` (XCUIScreen) returns 1320×2868 PNGs **without** alpha in
  110–200 ms. They match the simctl capture (1 of 39 k sampled pixels differs).
- Locales verified on Settings, Contacts and Calendar under `de_DE`, `ja_JP` and `ar_SA`. With
  `ar`, titles are right-aligned, chevrons point left and the list mirrors (RTL confirmed). The
  status bar override (09:41) stays in place across launches.

### Readiness

Measured by tracing screenshots after `simctl launch` (`spike/trace_launch.py`):

- Every app showed the launch zoom, then a **blank white body for 4–10 s**, before content
  appeared (Settings: blank from 3.7 s to 11.8 s). A screen-stability check alone therefore
  reports "ready" on the blank screen.
- Some screens never settle. Settings' Apple Account spinner kept changing pixels for a few
  seconds after the layout settled.

Two checks that worked:

1. **Screenshots only** (`spike/wait_ready.py`). Make a 66×143 grey thumbnail with ffmpeg.
   Ready = 3 consecutive frames with mean absolute difference < 0.6 **and** a content area
   (below the status bar) with grey stddev > 6, i.e. not blank. Accept a blank-but-stable
   screen only after 12 s. Result: Settings, Contacts and Calendar were ready after 13–15 s.
   Each poll costs about 0.5 s (screenshot plus ffmpeg).
2. **Runner, recommended** (`spike/runner_ready.py`, `spike/hybrid_ready.py`). Either
   `POST /launch`, which calls `XCUIApplication.launch()` and waits until the app is idle
   (5.5–25 s), or `simctl launch`, after which the first `GET /source` blocks until the app is
   idle (3–10 s). Then poll `/source` every 0.3 s and stop when two snapshots hash the same
   (type, identifier, label, frame, **with JSON keys sorted**). That added 0.3–0.7 s.

This check still accepted a **splash screen** in DailyAffirmations: the splash is stable for
about 1 s, then the onboarding replaces it. Recommendation: require stability for at least
1.5 s, and let the exploration agent decide whether a screen is a splash. Apps should skip
splashes under `-ShotwrightDemo`.

### Gotchas

- **Back-link in the status bar.** Launching app B while app A is in front shows "◀ A" under
  the clock, and the runner's `launch()` does the same. Fix: `simctl terminate` the foreground
  app, or `POST /home`, before launching. Both verified.
- First-run sheets appear (Calendar's "What's new"). The exploration agent has to dismiss them.
- The Dynamic Island appears in `recordVideo` frames and in some screenshots (home screen,
  fade-ins), but not in most app screenshots. Our device frame should draw its own island
  over that area.
- simctl screenshots have a few black pixels at the top-left corner, (0..2, 0..2). Harmless:
  the frame masks the corners.

## 2. Video

```sh
xcrun simctl io $U recordVideo --codec=h264 --force rec.mov 2> rec.log &   # default codec is hevc
# wait for "Recording started" on stderr (0.3–0.5 s), drive the app, then:
kill -INT $!; wait $!
```

ffprobe of a 5 s recording of an app launch:

| | hevc (default) | h264 |
|---|---|---|
| Resolution | 1320×2868 yuv420p | 1320×2868 yuv420p, High |
| Time base / r_frame_rate | 1/600, 600/1 | 1/600, 600/1 |
| Frames / avg fps | 130 / 27 | 106 / 29 |
| Frame interval | 1.7 ms – 1.42 s | 3.3 ms – 0.82 s |
| Bit rate | 1.6 Mb/s | 3.9 Mb/s |
| Colour tags | primaries smpte432 (P3), transfer sRGB, matrix bt709 | same |

- **Variable frame rate.** A frame is written only when the screen changes. A static 2.5 s
  recording contained **one frame and lasted 0.067 s**. The file ends at the last change (a
  5.3 s recording gave 3.65 s and 4.82 s files). Record wall-clock start and stop times and
  pad the end.
- **Colours.** Pixel values in the video match the sRGB PNG screenshot of the same screen
  (saturated blue (57,167,255) in the PNG, (53,166,255) in the video). The P3 tag is wrong.
  Retag as BT.709 and don't run a P3 → 709 conversion, or colours will shift.
- ffmpeg's `-color_primaries/-color_trc/-colorspace` output options were ignored, because
  frame metadata wins. Use the `setparams` filter instead.

App preview, constant 30 fps (6.9" preview size 886×1920; 1320×2868 scaled to 886 wide is
1926 tall, so crop 3 px top and bottom):

```sh
ffmpeg -v error -y -i rec.mov -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
 -filter_complex "[0:v]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=<pad s>,fps=30,\
scale=886:1926:flags=lanczos,crop=886:1920:0:3,setsar=1,format=yuv420p,\
setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]" \
 -map "[v]" -map 1:a -t <wall-clock seconds> \
 -c:v libx264 -profile:v high -level:v 4.0 -preset medium -crf 18 -maxrate 10M -bufsize 20M -g 30 \
 -c:a aac -b:a 256k -ar 48000 -ac 2 -movflags +faststart preview.mp4
```

Output: H.264 High, level 4.0, 886×1920, yuv420p, `avg_frame_rate=30/1`, every frame interval
exactly 33.3 ms, bt709/bt709/bt709 tags, AAC LC stereo 48 kHz. 5.5 s of video encoded in
1.0 s. For a full-resolution master to compose on the server, drop the `scale`/`crop` (the
output is 1320×2868 CFR 30, and x264 picks level 5.0).

Two things to check against Apple's current App Preview spec before the validator is
finalised: the per-device preview resolutions (886×1920 is the 6.9" value I know), and
whether a silent audio track is required. Including one is the safe default.

Recommendation: record with `--codec=h264` (or hevc to halve the size) during replay, then
normalise every clip with the command above. Always pass the wall-clock duration.

## 3. iPhone Duo

```sh
D=5F9334B3-52D5-41DD-A7ED-D94D485D9101
xcrun simctl bootstatus $D -b        # cold boot 47 s
xcrun simctl io $D enumerate
xcrun simctl io $D screenshot --display=1 outer.png   # 1398x2034 RGBA, 1.6 s
xcrun simctl io $D screenshot --display=3 inner.png   # 2007x2853 RGBA, 1.8 s
xcrun simctl io $D recordVideo --codec=h264 --display=1 outer.mov   # 1398x2034
```

Displays (from `enumerate`, and from `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone Duo.simdevicetype/Contents/Resources/capabilities.plist`):

| Screen ID | Name / device name | Pixels | Notes |
|---|---|---|---|
| 1 | LCD / `primary` | 1398×2034 @3x (466×678 pt) | outer (cover) display, P3, corner radii 8 (left) / 59 (right): the hinge is on the left |
| 3 | LCD-1 / `primary-1` | 2007×2853 @3x (669×951 pt) | inner display, sRGB, `nativeOrientation 270`, captured in portrait |
| 2, 4 | TVOut, Wireless (CarPlay) | 720×480 | ignore |
| 5 | Resizable | 7680×4320 scene | no surfaces; screenshot times out |

- Both capture sizes match Apple's sizes exactly (1398×2034 outer, 2007×2853 inner), in
  portrait. Flatten alpha as on the iPhone.
- **Without `--display`, simctl captures LCD-1 (the inner display).** Always pass `--display`.
- The device **boots folded**: the outer display shows SpringBoard and apps; the inner display
  is pure black (YMAX = 0) on the home screen and with an app running. The outer UI puts the
  status bar in a column on the right (09:41 and Wi-Fi in a circle).
- The runner works on the Duo unchanged. `/health` reports 466×678 pt and `/screenshot` returns
  1398×2034 without alpha. SpringBoard's tree contains windows for both 466×678 and 669×951.

### Fold / unfold: not possible programmatically on this build

What I tried:

- `xcrun simctl help`, `help io` and `help ui`: no fold, posture, hinge or display-selection
  subcommand.
- `screenConfig --display=1 power off`: the inner display stays black (checked for 12 s), and
  outer screenshots fail with "Timeout waiting for screen surfaces". After toggling power on
  either display, **both displays stayed black even after `power on`**, until the device was
  rebooted. Don't use `screenConfig power` in the pipeline.
- `screenConfig --display=5 geometry 2007x2853@3` was accepted, but display 5 has no
  surfaces.
- Xcode 27.1 has no Simulator.app. There is `Contents/Applications/DeviceHub.app`, and its
  binary only starts a system updater. Host-side CoreSimulator, SimulatorKit,
  IndigoLegacyHIDServices and the IDE device frameworks contain no hinge or fold code.
  `XCUIDevice` has no fold API in the 27.1 SDK headers.
- Inside the 27.1 runtime, SpringBoard has an internal `SBDisplayToolService`
  (`swapDisplayWithSettings:`, positions `closed | book | open | 0.0–1.0`,
  `-fade | -continuous | -wait`; service `com.apple.springboard.sbdisplay.service`). I called
  its argument parser successfully from a small tool run with `simctl spawn`. The swap itself
  requires the private entitlement `com.apple.springboard.sbdisplay`, and `simctl spawn`
  refuses an ad-hoc binary that carries it ("Security policy issue", SimXPCErrorDomain 163).
  I stopped there: getting past that would mean working around a security policy.
- Apple Developer Forums thread
  [847883](https://developer.apple.com/forums/thread/847883) asks the same question. Unfolding
  by hand in the Simulator UI works; there is no programmatic way and no reply from Apple.

Recommendation:

1. Automate the **outer** set now. Capture, video and the runner all work.
2. For the **inner** set, test a human-in-the-loop step tomorrow on a machine with a display:
   unfold once by hand in the Simulator/Device Hub UI, then let the pipeline capture with
   `--display=3`. Check that the unfolded state survives app relaunches. If it does, the agent
   asks the developer to unfold, then continues.
3. Don't promise an automated "Duo fold" beat in the demo until 2 works. Show the outer set and
   the manual unfold instead. Keep an eye on the forum thread and Xcode 27.1 updates.

## 4. UI driver: ShotwrightRunner (built, working)

Location: `ios/ShotwrightRunner/`. It is a hand-written `project.pbxproj` (objectVersion 77,
file-system-synchronized groups), a SwiftUI host app, and a UI test bundle with one test,
`RunnerTests/testServe`. That test starts an `NWListener` HTTP server on 127.0.0.1 and runs
XCUI calls on the main thread. No third-party code. The README there has the full API and
the exact commands.

```sh
DD=<derived data dir outside the repo>
xcodebuild build-for-testing -project ios/ShotwrightRunner/ShotwrightRunner.xcodeproj \
  -scheme ShotwrightRunner -destination "platform=iOS Simulator,id=$U" -derivedDataPath "$DD"
TEST_RUNNER_SHOTWRIGHT_PORT=8615 xcodebuild test-without-building \
  -xctestrun "$DD"/Build/Products/ShotwrightRunner_iphonesimulator*-arm64.xctestrun \
  -destination "platform=iOS Simulator,id=$U" \
  -only-testing:ShotwrightRunnerUITests/RunnerTests/testServe \
  -derivedDataPath "$DD" -resultBundlePath "$DD"/results/run-$(date +%s).xcresult &
until curl -s localhost:8615/health; do sleep 0.5; done
```

Routes: `GET /health`, `GET /source?bundleId=`, `GET /screenshot`, `POST /launch`
`{bundleId,args,env,activate}`, `/terminate`, `/home`, `/tap` `{x,y}|{identifier}|{label}`
(+`type`, `index`), `/swipe` `{x1,y1,x2,y2,duration,hold}|{direction}`, `/type` `{text}`,
`/shutdown`.

Verified against Settings: dumped the tree (177 elements, 19 KB JSON, stable ids such as
`com.apple.settings.general`). Tapped rows by coordinate, identifier and label, and confirmed
the navigation bar changed (General, Accessibility, Camera, back to Settings). Scrolled with
`/swipe`. Typed "Kamera" into the search field (`{"label":"Suchen","type":"searchField"}`).
Also ran on the Duo.

Latencies (curl round trip; low end idle, high end with other builds running):

| Call | Time |
|---|---|
| Build-for-testing | 8.8 s first build, 32 s clean under load, 2–6 s incremental |
| `test-without-building` until `/health` answers | 15–37 s |
| `GET /health` | 20–90 ms |
| `GET /source` (Settings, 177 nodes) | 70–120 ms warm, up to 290 ms under load; first call after a launch waits for idle (0.3–10 s) |
| `GET /screenshot` | 110–200 ms (simctl: 430 ms) |
| `POST /tap {x,y}` | 0.4–0.6 s with no navigation; 1.3–1.6 s when it pushes a screen (XCTest waits for quiescence) |
| `POST /tap {identifier}` | 0.7–0.9 s (snapshot, then coordinate tap); the XCUI query path took 2.4–10 s |
| `POST /swipe` | 1.3–1.4 s |
| `POST /type` (6 chars) | 3.7 s |
| `POST /launch` | 5.5–25 s (includes waiting for idle) |
| `POST /home` | 0.7–0.9 s |

### Gotchas, all handled or documented in the runner

- A failed XCUI interaction ends the test, even with `continueAfterFailure = true`. The first
  version died on a failed `typeText`. Fixed: `record(_:)` captures the issue, returns it as an
  HTTP error and doesn't forward it to XCTest. Verified with `POST /debug/fail`.
- `typeText` without keyboard focus retries for about 10 s, then fails. `/type` now checks focus
  first.
- A `/launch` sent right after `simctl install` failed ("Unknown application display
  identifier"). XCTest then retried internally and **blocked the runner for more than 4
  minutes** until I killed xcodebuild. The agent needs per-request timeouts and must restart
  the runner when `/health` stops answering. Prefer `simctl launch`, which fails in under a
  second.
- A snapshot taken during a push animation still contains the old screen (frames with x < 0).
  Wait for two identical snapshots.
- Swift's `JSONSerialization` output has random key order. Sort keys before hashing.
- Env vars reach the test only with the `TEST_RUNNER_` prefix. Without `-derivedDataPath`, each
  run leaves a folder in `~/Library/Developer/Xcode/DerivedData`.
- The log line `nw_listener_socket_inbox_create_socket setsockopt SO_NECP_LISTENUUID failed` is
  harmless.

Recommendation: adopt this runner as the UI driver and drop idb/WebDriverAgent from the plan.
The agent should:

1. start it once per booted device;
2. launch with `simctl launch` after `/home` or `terminate`;
3. use `/source` stability for readiness;
4. tap by identifier;
5. capture with `/screenshot`, which needs no alpha flattening.

## 5. Building a real app (DailyAffirmations)

```sh
SP=<scratchpad>/spike
rsync -a --exclude .git --exclude DerivedData /Users/yadaumur/daily-affirmations/DailyAffirmations/ $SP/app/DailyAffirmations/
cd $SP/app/DailyAffirmations
xcodebuild build -project DailyAffirmations.xcodeproj -scheme DailyAffirmations -configuration Debug \
  -sdk iphonesimulator -destination "platform=iOS Simulator,id=$U" -derivedDataPath $SP/app-dd
xcrun simctl install $U $SP/app-dd/Build/Products/Debug-iphonesimulator/DailyAffirmations.app
xcrun simctl launch $U yadaumur.DailyAffirmations -AppleLanguages "(ja)" -AppleLocale ja_JP
```

- Copy: 13 MB without `.git`. The project has 4 targets (app, widget extension, tests) and a
  `DEVELOPMENT_TEAM`, entitlements and an app group.
- Build: **69 s clean** (107 Swift files plus the widget extension), **5 s** with nothing
  changed. **No signing changes were needed**: Simulator builds use "Sign to Run Locally", so
  `CODE_SIGNING_ALLOWED=NO` was unnecessary. No warnings.
- App: 29 MB with a widget `.appex`. Install takes 1.7 s; uninstall plus install takes 2.8 s.
  Bundle id `yadaumur.DailyAffirmations`, display name "Lumina", 17 `.lproj` folders.
- Captures: onboarding in de, ja and ar, 1320×2868, no alpha (runner `/screenshot`). Arabic
  is RTL with Arabic text. The tree dump works (splash 9 nodes, onboarding 13–27 nodes).
- Problems found:
  - **The app's language sticks.** The app stores `appLanguage` in the
    `group.com.yadaumur.DailyAffirmations` defaults on first launch. Later launches with
    `-AppleLanguages (ja)` or `(ar)` flipped the layout but kept the German text. Two fixes
    worked: a fresh install per locale (uninstall + install, confirmed Arabic text), or passing
    the app's own key as a launch argument, `-appLanguage ja`, because the argument domain also
    overrides suite defaults. The second is app-specific, so the generic pipeline should
    reinstall per locale, which means replaying onboarding each time.
  - **No accessibility identifiers.** Buttons only have localized labels ("Weiter" / "次へ" /
    "استمرار"); identifiers are SF Symbol names on images. Steps recorded by label break in
    other locales. Selectors need a locale-independent fallback: type + index, position, or
    the step's frame in the reference locale.
  - **Splash, then onboarding.** Readiness accepted the 1-second-stable splash (see spike 1).
    One onboarding page keeps "Continue" disabled until an option is picked, so blind taps do
    nothing. Exploration has to reason about it.
  - The `-ShotwrightDemo` contract isn't implemented, as expected for a third-party app.

## What threatens the plan

1. **Duo inner display (high).** I found no programmatic unfold. The inner set is mandatory
   from April 2027, and the demo has a "Duo fold" beat. See the options in spike 3. Test the
   manual-unfold handoff on Oct 27.
2. **Locale switching in real apps (medium).** Apps with an in-app language setting ignore
   `-AppleLanguages` after first launch. Reinstalling per locale works, but repeats onboarding
   and permission prompts. Budget replay time for it.
3. **Localized selectors (medium).** Apps without accessibility identifiers need structural
   selectors. Otherwise, at 40 locales, Muse "repair" will run on almost every step.
4. **Slow launches on 8 GB (medium).** Each app launch took 5–25 s to become usable. For
   example, 10 screens × 40 locales × 2 devices × about 15 s is several hours per app. Keep
   relaunches to a minimum: capture several screens per launch, and launch once per locale.
5. **Runner hangs (low, handled).** XCUI calls can block for minutes. The agent needs
   per-request timeouts and must restart the runner, which takes 15–37 s to come back.
6. **The plan's Risks table** still says "idb maintenance → fall back to WebDriverAgent". It
   should now say we use our own XCUITest runner, so neither is needed.

## Files

- Runner: `ios/ShotwrightRunner/` (project, `Host/HostApp.swift`, `UITests/HTTPServer.swift`,
  `UITests/RunnerTests.swift`, `README.md`).
- Spike scripts and captures (scratchpad, not committed): `trace_launch.py`,
  `wait_ready.py`, `runner_ready.py`, `hybrid_ready.py`, `flat_tree.py`, `duotool/`
  (`probe.m`, `duofold.m`), screenshots, videos, `duo/`.
