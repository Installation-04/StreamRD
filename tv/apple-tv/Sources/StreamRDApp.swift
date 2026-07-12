import SwiftUI

/// StreamRD for Apple TV (tvOS 17+).
/// Add these Sources to a tvOS App target in Xcode — see the README.
@main
struct StreamRDApp: App {
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var session: SessionStore

    var body: some View {
        Group {
            if session.token == nil {
                LoginView()
            } else {
                HomeView()
            }
        }
        .task { await session.restore() }
    }
}
