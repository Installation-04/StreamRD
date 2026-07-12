# StreamRD for Apple TV (tvOS)

SwiftUI client for the StreamRD backend. Ships as source files you drop into
a tvOS App target (Xcode projects don't diff well in git, so none is checked in).

## Set up the Xcode project

1. Xcode → File → New → Project → **tvOS → App** (SwiftUI, Swift).
   Name it `StreamRD`, bundle id e.g. `com.streamrd.tv`. Minimum tvOS 17.
2. Delete the generated `ContentView.swift` / `<App>.swift` files.
3. Drag everything from `Sources/` into the target.
4. If your server is plain HTTP on the LAN, add an App Transport Security
   exception in `Info.plist` (`NSAllowsLocalNetworking` or a domain exception).
   With HTTPS via the reverse proxy nothing is needed.
5. Run on the tvOS Simulator or a real Apple TV (Devices & Simulators pairing).

## What it does

- Server URL setting with connectivity test (`/api/health`)
- Login, Netflix-style home rows with focus-driven navigation (`.buttonStyle(.card)`)
- Title detail and full-screen playback with `AVPlayer` / `VideoPlayer`
- Streams resolve through the backend's `/api/play`, which picks the user's
  debrid provider and falls back automatically

Admin functionality is intentionally web-only.
