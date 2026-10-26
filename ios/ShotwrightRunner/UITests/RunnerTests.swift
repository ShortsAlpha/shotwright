import XCTest

/// One long-running UI test that turns XCUITest into an HTTP-controlled UI driver.
///
/// HTTP requests arrive on a background queue; every XCUI call runs on the main thread,
/// one at a time, from the loop in `testServe`.
final class RunnerTests: XCTestCase {
    private let driver = Driver()

    override func setUp() {
        continueAfterFailure = true
    }

    /// XCUI interaction errors are reported as test issues, not thrown. Capture them so the
    /// HTTP response can carry the error. Not forwarding to super keeps XCTest from ending the
    /// long-running test on the first failed interaction.
    override func record(_ issue: XCTIssue) {
        driver.issues.append(issue.compactDescription)
        NSLog("SHOTWRIGHT_RUNNER issue: %@", issue.compactDescription)
    }

    func testServe() throws {
        let env = ProcessInfo.processInfo.environment
        let port = UInt16(env["SHOTWRIGHT_PORT"] ?? "") ?? 8615
        let jobs = MainThreadJobs()
        let server = try HTTPServer(port: port) { [driver] req, respond in
            jobs.push { respond(driver.handle(req)) }
        }
        server.start { state in NSLog("SHOTWRIGHT_RUNNER listener %@ port=%d", state, Int(port)) }
        NSLog("SHOTWRIGHT_RUNNER_READY port=%d", Int(port))

        while !driver.shouldStop {
            if let job = jobs.pop() {
                job()
            } else {
                RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.005))
            }
        }
        server.stop()
    }
}

/// Thread-safe FIFO of closures executed on the main thread by the test loop.
final class MainThreadJobs {
    private var items: [() -> Void] = []
    private let lock = NSLock()
    func push(_ job: @escaping () -> Void) { lock.lock(); items.append(job); lock.unlock() }
    func pop() -> (() -> Void)? {
        lock.lock(); defer { lock.unlock() }
        return items.isEmpty ? nil : items.removeFirst()
    }
}

final class Driver {
    var shouldStop = false
    var issues: [String] = []
    /// Target of /source, /tap {identifier}, /type when the request names no bundleId.
    var currentBundleId = "com.apple.springboard"
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    func handle(_ req: HTTPRequest) -> HTTPResponse {
        let t0 = CFAbsoluteTimeGetCurrent()
        issues.removeAll()
        var status = 200
        var result: [String: Any]
        do {
            switch (req.method, req.path) {
            case ("GET", "/health"): result = health()
            case ("GET", "/source"): result = try source(req.query)
            case ("GET", "/screenshot"):
                return HTTPResponse(status: 200, contentType: "image/png",
                                    body: XCUIScreen.main.screenshot().pngRepresentation)
            case ("POST", "/tap"): result = try tap(try req.json())
            case ("POST", "/swipe"): result = try swipe(try req.json())
            case ("POST", "/type"): result = try type(try req.json())
            case ("POST", "/launch"): result = try launch(try req.json())
            case ("POST", "/terminate"): result = try terminate(try req.json())
            case ("POST", "/home"): XCUIDevice.shared.press(.home); result = [:]
            case ("POST", "/shutdown"): shouldStop = true; result = [:]
            case ("POST", "/debug/fail"):  // provokes an XCUI failure to prove the runner survives it
                XCUIApplication(bundleIdentifier: currentBundleId).buttons["shotwright.no.such.element"].tap()
                result = [:]
            default:
                return .json(["ok": false, "error": "no route \(req.method) \(req.path)"], status: 404)
            }
            result["ok"] = issues.isEmpty
            if !issues.isEmpty { result["error"] = issues.joined(separator: "\n"); status = 500 }
        } catch {
            result = ["ok": false, "error": "\(error)"]
            status = 400
        }
        result["ms"] = Int((CFAbsoluteTimeGetCurrent() - t0) * 1000)
        return .json(result, status: status)
    }

    // MARK: routes

    private func health() -> [String: Any] {
        let f = springboard.frame
        return ["runner": "shotwright", "currentBundleId": currentBundleId,
                "screen": ["w": num(f.width), "h": num(f.height)],
                "orientation": XCUIDevice.shared.orientation.rawValue]
    }

    private func source(_ q: [String: String]) throws -> [String: Any] {
        let id = q["bundleId"] ?? currentBundleId
        let app = XCUIApplication(bundleIdentifier: id)
        let state = app.state
        guard state == .runningForeground || state == .runningBackground else {
            throw RunnerError("\(id) is not running (state \(stateName(state)))")
        }
        let snap = try app.snapshot()
        var count = 0
        let tree = serialize(snap, &count)
        return ["bundleId": id, "state": stateName(state), "count": count, "tree": tree]
    }

    private func tap(_ b: [String: Any]) throws -> [String: Any] {
        if b["identifier"] != nil || b["label"] != nil {
            // Fast path: find the element in one snapshot and tap its centre. Element queries plus
            // XCUIElement.tap() cost 2-10 s on this machine; snapshot + coordinate tap ~0.5 s.
            if (b["query"] as? Bool) != true, let f = try findOnScreen(b) {
                point(Double(f.midX), Double(f.midY)).tap()
                return ["tapped": rect(f), "via": "snapshot"]
            }
            // Slow path (also scrolls off-screen elements into view).
            if let el = try element(b) {
                let frame = el.frame
                el.tap()
                return ["tapped": rect(frame), "via": "query"]
            }
        }
        guard let x = b["x"] as? Double, let y = b["y"] as? Double else {
            throw RunnerError("tap needs {x,y} in points, {identifier} or {label}")
        }
        point(x, y).tap()
        return ["tapped": ["x": x, "y": y]]
    }

    private func swipe(_ b: [String: Any]) throws -> [String: Any] {
        if let dir = b["direction"] as? String {
            let target = try element(b) ?? XCUIApplication(bundleIdentifier: (b["bundleId"] as? String) ?? currentBundleId)
            switch dir {
            case "up": target.swipeUp()
            case "down": target.swipeDown()
            case "left": target.swipeLeft()
            case "right": target.swipeRight()
            default: throw RunnerError("direction must be up|down|left|right")
            }
            return ["swiped": dir]
        }
        guard let x1 = b["x1"] as? Double, let y1 = b["y1"] as? Double,
              let x2 = b["x2"] as? Double, let y2 = b["y2"] as? Double else {
            throw RunnerError("swipe needs {x1,y1,x2,y2[,duration,hold]} or {direction[,identifier]}")
        }
        let duration = max((b["duration"] as? Double) ?? 0.3, 0.05)
        let hold = (b["hold"] as? Double) ?? 0  // >0 stops momentum scrolling at the end
        let speed = max(hypot(x2 - x1, y2 - y1) / duration, 50)
        point(x1, y1).press(forDuration: 0.05, thenDragTo: point(x2, y2),
                            withVelocity: XCUIGestureVelocity(rawValue: speed), thenHoldForDuration: hold)
        return ["swiped": ["x1": x1, "y1": y1, "x2": x2, "y2": y2]]
    }

    private func type(_ b: [String: Any]) throws -> [String: Any] {
        guard let text = b["text"] as? String else { throw RunnerError("type needs {text}") }
        let app = XCUIApplication(bundleIdentifier: (b["bundleId"] as? String) ?? currentBundleId)
        // typeText on an element without keyboard focus fails after ~10 s of retries, so check first.
        let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
        if let el = try element(b) {
            if !((el.value(forKey: "hasKeyboardFocus") as? Bool) ?? false) { el.tap() }
        }
        guard focused.waitForExistence(timeout: 2) else {
            throw RunnerError("no element has keyboard focus; tap a text field first or pass {identifier|label}")
        }
        focused.typeText(text)
        return ["typed": text.count]
    }

    private func launch(_ b: [String: Any]) throws -> [String: Any] {
        guard let id = b["bundleId"] as? String else { throw RunnerError("launch needs {bundleId}") }
        let app = XCUIApplication(bundleIdentifier: id)
        if (b["activate"] as? Bool) == true {
            app.activate()  // bring to front without relaunching
        } else {
            app.launchArguments = (b["args"] as? [String]) ?? []
            app.launchEnvironment = (b["env"] as? [String: String]) ?? [:]
            app.launch()  // terminates a running instance, launches, waits until idle
        }
        currentBundleId = id
        return ["bundleId": id, "state": stateName(app.state)]
    }

    private func terminate(_ b: [String: Any]) throws -> [String: Any] {
        let id = (b["bundleId"] as? String) ?? currentBundleId
        XCUIApplication(bundleIdentifier: id).terminate()
        return ["terminated": id]
    }

    // MARK: helpers

    /// Element by {identifier} or {label} (+ optional {type}, {index}) in {bundleId}
    /// (default: current app); nil if neither identifier nor label is given.
    private func element(_ b: [String: Any]) throws -> XCUIElement? {
        let app = XCUIApplication(bundleIdentifier: (b["bundleId"] as? String) ?? currentBundleId)
        var type = XCUIElement.ElementType.any
        if let t = b["type"] as? String {
            guard let i = Self.typeNames.firstIndex(of: t), let et = XCUIElement.ElementType(rawValue: UInt(i)) else {
                throw RunnerError("unknown element type \(t)")
            }
            type = et
        }
        let query: XCUIElementQuery
        let what: String
        if let ident = b["identifier"] as? String {
            query = app.descendants(matching: type).matching(identifier: ident); what = "identifier \(ident)"
        } else if let label = b["label"] as? String {
            query = app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)); what = "label \(label)"
        } else {
            return nil
        }
        let el = query.element(boundBy: (b["index"] as? Int) ?? 0)
        guard el.waitForExistence(timeout: (b["timeout"] as? Double) ?? 5) else {
            throw RunnerError("no element with \(what)")
        }
        return el
    }

    /// Frame of the index-th element matching identifier/label/type in one snapshot, if its centre
    /// is on screen; nil otherwise.
    private func findOnScreen(_ b: [String: Any]) throws -> CGRect? {
        let app = XCUIApplication(bundleIdentifier: (b["bundleId"] as? String) ?? currentBundleId)
        let snap = try app.snapshot()
        let ident = b["identifier"] as? String, label = b["label"] as? String, type = b["type"] as? String
        var matches: [CGRect] = []
        func walk(_ s: XCUIElementSnapshot) {
            if (ident == nil || s.identifier == ident!) && (label == nil || s.label == label!)
                && (type == nil || typeName(s.elementType) == type!) && !s.frame.isEmpty {
                matches.append(s.frame)
            }
            s.children.forEach(walk)
        }
        walk(snap)
        let i = (b["index"] as? Int) ?? 0
        guard i < matches.count else { return nil }
        let f = matches[i]
        return snap.frame.contains(CGPoint(x: f.midX, y: f.midY)) ? f : nil
    }

    /// Screen point in points. SpringBoard always covers the whole screen, so its coordinate
    /// space is the screen's, whichever app is in front.
    private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        springboard.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    private func serialize(_ s: XCUIElementSnapshot, _ count: inout Int) -> [String: Any] {
        count += 1
        var d: [String: Any] = ["type": typeName(s.elementType), "frame": rect(s.frame), "enabled": s.isEnabled]
        if !s.identifier.isEmpty { d["identifier"] = s.identifier }
        if !s.label.isEmpty { d["label"] = s.label }
        if let v = s.value {
            let str = (v as? String) ?? "\(v)"
            if !str.isEmpty { d["value"] = str }
        }
        if let p = s.placeholderValue, !p.isEmpty { d["placeholder"] = p }
        if s.isSelected { d["selected"] = true }
        let kids = s.children.map { serialize($0, &count) }
        if !kids.isEmpty { d["children"] = kids }
        return d
    }

    private func num(_ v: CGFloat) -> Double { v.isFinite ? (Double(v) * 10).rounded() / 10 : 0 }
    private func rect(_ r: CGRect) -> [String: Double] {
        ["x": num(r.origin.x), "y": num(r.origin.y), "w": num(r.size.width), "h": num(r.size.height)]
    }

    private func stateName(_ s: XCUIApplication.State) -> String {
        switch s {
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "backgroundSuspended"
        case .runningBackground: return "background"
        case .runningForeground: return "foreground"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    private static let typeNames = [
        "any", "other", "application", "group", "window", "sheet", "drawer", "alert", "dialog", "button",
        "radioButton", "radioGroup", "checkBox", "disclosureTriangle", "popUpButton", "comboBox", "menuButton",
        "toolbarButton", "popover", "keyboard", "key", "navigationBar", "tabBar", "tabGroup", "toolbar",
        "statusBar", "table", "tableRow", "tableColumn", "outline", "outlineRow", "browser", "collectionView",
        "slider", "pageIndicator", "progressIndicator", "activityIndicator", "segmentedControl", "picker",
        "pickerWheel", "switch", "toggle", "link", "image", "icon", "searchField", "scrollView", "scrollBar",
        "staticText", "textField", "secureTextField", "datePicker", "textView", "menu", "menuItem", "menuBar",
        "menuBarItem", "map", "webView", "incrementArrow", "decrementArrow", "timeline", "ratingIndicator",
        "valueIndicator", "splitGroup", "splitter", "relevanceIndicator", "colorWell", "helpTag", "matte",
        "dockItem", "ruler", "rulerMarker", "grid", "levelIndicator", "cell", "layoutArea", "layoutItem",
        "handle", "stepper", "tab", "touchBar", "statusItem",
    ]

    private func typeName(_ t: XCUIElement.ElementType) -> String {
        let i = Int(t.rawValue)
        return i < Self.typeNames.count ? Self.typeNames[i] : "type\(i)"
    }
}
