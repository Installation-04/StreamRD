# Phosphor Desktop

A thin native desktop wrapper for [Phosphor](../web) — the self-hosted debrid
cockpit web app — built with **Tauri v2**.

## What this is (and isn't)

This is **not** a reimplementation of the Phosphor UI. It is a small native
window that:

1. On first launch, shows a one-time retro terminal-styled settings screen
   (`index.html` / `main.js`, no framework) asking for your **Phosphor App
   URL** — the address where your self-hosted Phosphor *web app* is reachable
   (e.g. `http://192.168.1.50:3100` on your LAN, or `https://phosphor.example.com`
   behind a reverse proxy). This is the web app's URL, **not** the raw debrid
   API port (61337) — the web app itself talks to that API.
2. Saves that URL to the webview's `localStorage` (persists across launches).
3. Navigates the same window to that URL, so the real Phosphor web app loads
   and runs natively inside the window from then on.
4. Lets you get back to the settings screen at any time via the
   **Phosphor > Settings...** menu item, or the `Ctrl/Cmd+,` shortcut, in
   case you need to change the URL (new server, moved instance, etc).

Everything else — search, debrid linking, streaming, the actual UI — is
entirely the Phosphor web app's job. This wrapper never fetches, caches, or
renders any of that itself.

## Why Tauri v2

Tauri v2 (stable since October 2024) is the current standard release line —
v1 is in maintenance mode. Tauri produces a much smaller/lighter binary than
Electron because it uses the OS's own webview (WebView2 on Windows, WKWebView
on macOS, WebKitGTK on Linux) instead of bundling Chromium.

## The navigation/CSP tradeoff

The entire point of this wrapper is to load a URL the user supplies at
runtime, which is fundamentally at odds with Tauri's default "only trust
your own bundled origin" security posture. Two things were relaxed
deliberately to make that possible, both documented here so it's an explicit,
known tradeoff rather than an oversight:

- **`app.security.csp` is `null`** in `src-tauri/tauri.conf.json`, i.e. no
  Content-Security-Policy is injected. The Phosphor web app is expected to
  load its own scripts/styles, open WebSocket/API connections, etc. from
  whatever origin the user configured, and a locked-down CSP scoped to this
  wrapper's own bundled assets would break that.
- **`on_navigation` in `src-tauri/src/main.rs`** allows navigation to any
  `http`/`https` URL (plus the internal scheme used to serve the bundled
  settings page), instead of pinning navigation to a fixed allowlist of
  domains.

Because of this, the wrapper places a fair amount of trust in whatever URL
the user enters — it is designed for pointing at a Phosphor instance you
control (your own LAN/server), not for browsing arbitrary third-party sites.
No remote-domain IPC access is granted (`dangerousRemoteDomainIpcAccess` is
not configured), so the loaded Phosphor web app cannot call into the native
Tauri layer — it's just an isolated webview, same as opening the URL in an
ordinary browser tab.

## Icons

`src-tauri/icons/` is intentionally empty in this repo — there's no image
tooling available to generate real icon binaries here. Before producing a
real build, generate them from a source PNG (ideally 1024x1024+) with:

```sh
cargo tauri icon path/to/your-logo.png
```

This populates `src-tauri/icons/` with the full platform icon set
(`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, etc.)
that `src-tauri/tauri.conf.json`'s `bundle.icon` list already points at.
`tauri dev` does not require these to exist; `tauri build` does.

## Prerequisites

- **Rust toolchain** — install via [rustup](https://rustup.rs).
- **Node.js** (for the Tauri CLI, via `npm`).
- Platform-specific system build dependencies for Tauri:
  - **Windows**: the "Desktop development with C++" workload from the
    Visual Studio Build Tools (MSVC), and WebView2 Runtime (preinstalled on
    Windows 10 21H2+ / Windows 11).
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
  - **Linux**: `webkit2gtk-4.1`, `libgtk-3`, `libayatana-appindicator3`,
    `librsvg2`, and standard build essentials (exact package names vary by
    distro — see the
    [Tauri Linux prerequisites guide](https://v2.tauri.app/start/prerequisites/)
    for your distro's package manager commands).

See the official [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
for full, up-to-date, per-OS instructions.

## Development

```sh
npm install
npm run tauri dev
```

This compiles the Rust side and opens the app window pointed at the bundled
`index.html` settings screen (there is no dev server/bundler involved —
`index.html`/`main.js` are plain static files).

## Building installers

```sh
npm run tauri build
```

Produces a native installer/bundle for the current platform (`.msi`/`.exe`
on Windows, `.dmg`/`.app` on macOS, `.deb`/`.AppImage`/`.rpm` on Linux) under
`src-tauri/target/release/bundle/`. Cross-compiling installers for other
platforms generally requires running the build on that OS (or Tauri's
GitHub Actions-based CI setup), which is out of scope here.

## A note on this code

This project was written by hand in an environment without a Rust
toolchain available, so **the Rust/Tauri code has not been compiled or run**
— only carefully cross-checked against the Tauri v2 API/config surface. Run
`npm install && npm run tauri dev` in a real environment as the first
verification step.

## File map

- `src-tauri/Cargo.toml` — Rust crate manifest (Tauri v2 + `url` crate).
- `src-tauri/tauri.conf.json` — app/window/bundle/security config.
- `src-tauri/capabilities/default.json` — Tauri v2 permission grant for the
  main window (just `core:default`; no plugins are used).
- `src-tauri/src/main.rs` — builds the single "PHOSPHOR" window, the
  `connect` command the settings page invokes to navigate to the configured
  URL, and the native "Settings..." menu item / `Ctrl/Cmd+,` accelerator
  that navigates back to the bundled settings page.
- `src-tauri/build.rs` — required Tauri build-script hook.
- `src-tauri/icons/` — placeholder/empty; see [Icons](#icons) above.
- `index.html` / `main.js` — the one-time retro terminal settings screen.
- `package.json` — Tauri CLI dev-dependency and `dev`/`build` scripts.
