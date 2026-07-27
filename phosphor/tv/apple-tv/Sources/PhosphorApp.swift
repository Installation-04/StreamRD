import SwiftUI

/// Phosphor for Apple TV (tvOS 17+).
/// Add these Sources to a tvOS App target in Xcode — see the README.
@main
struct PhosphorApp: App {
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
        }
    }
}

/// Swaps between the auth/settings screen and the main tab UI based on
/// whether a session token is present, and restores a saved session on
/// first launch.
struct RootView: View {
    @EnvironmentObject var session: SessionStore

    var body: some View {
        Group {
            if session.token == nil {
                AuthView()
            } else {
                MainTabView()
            }
        }
        .task { await session.restore() }
    }
}
