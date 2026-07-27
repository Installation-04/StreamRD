# Phosphor for Apple TV (tvOS)

SwiftUI client for the Phosphor backend. Ships as source files you drop into
a tvOS App target (Xcode projects don't diff well in git, so none is checked
in — same approach as the sibling StreamRD tvOS client in this monorepo).

## Visual design

A retro terminal / CRT look: glowing green phosphor text on a near-black
screen, monospaced type only (SwiftUI's `.monospaced` font design — no
bundled or downloaded fonts), a faint scanline overlay, a soft vignette, and
chunky uppercase labels. This is original to Phosphor and unrelated to the
StreamRD client's visuals.

## Set up the Xcode project

1. Xcode → File → New → Project → **tvOS → App** (interface: SwiftUI,
   language: Swift). Name it `Phosphor`, bundle id e.g. `com.phosphor.tv`.
   Set the minimum deployment target to **tvOS 17.0**.
2. Delete the generated `ContentView.swift` and `<App>.swift` files.
3. Drag everything under `Sources/` into the target (make sure "Copy items
   if needed" is checked and the target membership is set).
4. **App Transport Security exception** — Phosphor servers are typically
   plain HTTP on the local network. Add to `Info.plist`:
   ```xml
   <key>NSAppTransportSecurity</key>
   <dict>
       <key>NSAllowsLocalNetworking</key>
       <true/>
       <key>NSAllowsArbitraryLoads</key>
       <true/>
   </dict>
   ```
   `NSAllowsLocalNetworking` covers `.local`/private-IP addresses; if your
   server is reachable at a public hostname without HTTPS, use
   `NSAllowsArbitraryLoads` instead (or add a per-domain exception). Nothing
   is needed if you put a reverse proxy with HTTPS in front of the server.
5. Run on the tvOS Simulator or a real Apple TV (Xcode → Devices &
   Simulators to pair one over the network or USB-C).

## What it does

- **Server + login/signup** (`AuthView`) — server URL field with a
  "Save & test connection" action against `GET /api/health`, plus a
  login/sign-up form (`POST /api/auth/login` / `/signup`). Session token is
  persisted in `UserDefaults` and restored on next launch via
  `GET /api/account/profile`.
- **Search** (`SearchView`) — the entire browsing model. Query plus optional
  min-seeders / max-size filters and a sort order hit `GET /api/search`
  (fanned out across your configured Torznab indexers server-side). Results
  with a magnet link can be added to your debrid queue in one action
  (`POST /api/downloads`); non-magnet results are labeled but not
  addable per the API contract.
- **Queue** (`DownloadsView`) — lists your jobs (`GET /api/downloads`),
  polling `POST /api/downloads/:id/refresh` every ~4s for anything still
  `queued`/`downloading`. Finished jobs get a "Play" action; any job can be
  removed (`DELETE /api/downloads/:id`).
- **Player** (`PlayerView`) — full-screen `VideoPlayer`/`AVPlayer` over the
  resolved `streamUrl`, with the idle timer disabled while playing.
- **Account** (`AccountView`) — shows the signed-in user, lets you re-point
  the server URL, and sign out.

Top-level navigation is a `TabView` (Search / Queue / Account) rather than a
`NavigationStack` push hierarchy — there's no drill-down detail screen in
this app's model (actions are inline on each row), so a tab bar is the more
idiomatic tvOS fit.

Admin functionality (indexer management, server settings, user management)
is intentionally web-only and not present here.
