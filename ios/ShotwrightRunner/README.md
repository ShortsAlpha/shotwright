# ShotwrightRunner

Our own UI driver for the iOS Simulator. It is a plain XCUITest bundle whose single test,
`RunnerTests/testServe`, never returns: it starts an HTTP server (Network.framework
`NWListener`, bound to `127.0.0.1` only) and executes each request with XCUITest APIs on the
main thread. No third-party code (no WebDriverAgent, no idb).

The project file is hand-written (`objectVersion 77`, file-system-synchronized groups), so new
`.swift` files in `Host/` or `UITests/` are picked up without editing `project.pbxproj`.

```
Host/HostApp.swift        tiny SwiftUI app; only exists because a UI test bundle needs a target app
UITests/HTTPServer.swift  minimal HTTP/1.1 server (Content-Length bodies, Connection: close)
UITests/RunnerTests.swift the long-running test and the route handlers
```

## Build (once per Xcode version: about 30 s clean, about 6 s incremental)

```sh
DD=/path/to/derived-data   # anything outside the repo
xcodebuild build-for-testing \
  -project ios/ShotwrightRunner/ShotwrightRunner.xcodeproj \
  -scheme ShotwrightRunner \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -derivedDataPath "$DD"
```

No signing setup is needed: Simulator builds are signed "Sign to Run Locally".
The build produces `$DD/Build/Products/ShotwrightRunner_iphonesimulator<SDK>-arm64.xctestrun`.

## Run (20–37 s until `/health` answers)

```sh
TEST_RUNNER_SHOTWRIGHT_PORT=8615 xcodebuild test-without-building \
  -xctestrun "$DD"/Build/Products/ShotwrightRunner_iphonesimulator*-arm64.xctestrun \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -only-testing:ShotwrightRunnerUITests/RunnerTests/testServe \
  -derivedDataPath "$DD" \
  -resultBundlePath "$DD"/results/run-$(date +%s).xcresult
```

- `TEST_RUNNER_<NAME>` variables are passed to the test process without the prefix, so the
  port is `SHOTWRIGHT_PORT` inside the runner (default 8615).
- The Simulator shares the Mac's network stack: the agent talks to `http://127.0.0.1:8615`.
- Keep the process running in the background; stop it with `POST /shutdown` (the test then
  passes and xcodebuild exits 0) or by killing xcodebuild.
- Pass `-derivedDataPath` and `-resultBundlePath`; otherwise each run leaves a
  `ShotwrightRunner-*` folder with logs and an `.xcresult` in `~/Library/Developer/Xcode/DerivedData`.
- The same build runs on every iOS 17+ simulator (tested on iPhone 17 Pro Max / iOS 27.0 and
  iPhone Duo / iOS 27.1). On the Duo, `/health` reports the outer display (466 x 678 pt).
- Poll `GET /health` until it answers before sending anything else.

## API

All responses are JSON with `ok` and `ms` (time spent in the runner). Coordinates are in
points (the iPhone 17 Pro Max screen is 440 x 956 pt; screenshots are 3x).

| Route | Body / query | Notes |
|---|---|---|
| `GET /health` | | screen size in points, current bundle id |
| `GET /source?bundleId=…` | | accessibility tree: `type`, `identifier`, `label`, `value`, `placeholder`, `frame {x,y,w,h}`, `enabled`, `selected`, `children`; plus `count` and app `state`. Defaults to the last launched app |
| `GET /screenshot` | | PNG of the screen, already without alpha (1320 x 2868 on iPhone 6.9") |
| `POST /launch` | `{bundleId, args?, env?, activate?}` | `XCUIApplication.launch()`: terminates a running instance, launches, waits until the app is idle. `activate: true` brings it to the front without relaunching |
| `POST /terminate` | `{bundleId?}` | |
| `POST /home` | | presses Home (use before `/launch` to avoid the "◀ App" back-link in the status bar) |
| `POST /tap` | `{x, y}` or `{identifier}` or `{label}` (+ `type`, `index`, `bundleId`, `timeout`, `query`) | coordinate taps go through SpringBoard, so they hit whatever app is in front. `identifier`/`label` taps find the element in one snapshot and tap its centre (about 0.7 s); if it is not on screen, or with `query: true`, they fall back to an XCUI query + `tap()` (2–10 s), which also scrolls it into view |
| `POST /swipe` | `{x1, y1, x2, y2, duration?, hold?}` or `{direction, identifier?/label?}` | `hold > 0` stops momentum at the end |
| `POST /type` | `{text}` (+ optional element selector, which is tapped first) | fails fast if nothing has keyboard focus |
| `POST /shutdown` | | ends the test |
| `POST /debug/fail` | | provokes an XCUI failure, to check the runner survives it |

Examples:

```sh
curl -s localhost:8615/health
curl -s -X POST localhost:8615/home
curl -s -X POST localhost:8615/launch -d '{"bundleId":"com.apple.Preferences","args":["-AppleLanguages","(de)","-AppleLocale","de_DE"]}'
curl -s 'localhost:8615/source?bundleId=com.apple.Preferences' > tree.json
curl -s -X POST localhost:8615/tap -d '{"identifier":"com.apple.settings.general","bundleId":"com.apple.Preferences"}'
curl -s -X POST localhost:8615/tap -d '{"x":220,"y":424}'
curl -s -X POST localhost:8615/swipe -d '{"x1":220,"y1":750,"x2":220,"y2":300,"duration":0.3,"hold":0.2}'
curl -s -X POST localhost:8615/type -d '{"label":"Search","type":"searchField","text":"Camera"}'
curl -s localhost:8615/screenshot -o shot.png
```

## Behaviour to know

- XCUI interaction failures are captured in `record(_:)` and returned as `{"ok":false,"error":…}`
  (HTTP 500). They are deliberately not forwarded to XCTest, because XCTest would otherwise end
  the test on the first failed interaction, even with `continueAfterFailure = true`.
- Requests run one at a time. A slow XCUI call (launch waits for the app to go idle) blocks the
  queue, so the agent should use per-call timeouts and restart the runner if `/health` stops
  answering.
- After `simctl install`, SpringBoard can take a moment to register the app. A `/launch` sent
  immediately can fail with "Unknown application display identifier". XCTest then retries
  internally and the runner stayed blocked for more than 4 minutes (until killed). Prefer
  `xcrun simctl launch` (fails in under a second) and use the runner only once the app is up:
  the first `/source` for the app waits until it is idle, then poll until the tree is stable.
- The tree is a snapshot. While a push animation runs it still contains the previous screen
  (frames with negative x). Before acting, poll `/source` until two consecutive snapshots
  match. Sort JSON keys before hashing, because key order is not stable.
