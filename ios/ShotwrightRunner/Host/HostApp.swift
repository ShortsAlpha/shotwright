import SwiftUI

// Tiny host app. It exists only because a UI test bundle needs a target application;
// the runner never drives it.
@main
struct ShotwrightRunnerHostApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Shotwright runner host")
                .accessibilityIdentifier("shotwright.host")
        }
    }
}
