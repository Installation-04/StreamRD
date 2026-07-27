# Phosphor for Android TV / Fire TV

React Native TV client for **Phosphor** — a self-hosted "debrid cockpit."
Built on [`react-native-tvos`](https://github.com/react-native-tvos/react-native-tvos).
Connect your own debrid account (Real-Debrid, AllDebrid, Premiumize, Torbox),
search torrent indexers through your Phosphor server (Jackett/Prowlarr via
Torznab), add a result with one click, and stream it once the debrid
provider has it ready. There is no curated catalog — search is the whole
browsing model, and there are no admin screens (that's web-only).

## Visual style

Green phosphor-on-black CRT terminal: system monospace font only (no
bundled or fetched fonts), a scanline overlay, box-drawing panel borders,
uppercase chunky labels, and a blinking cursor accent. Nothing here needs
network access to render its own UI chrome.

## Screens

1. **Settings** — server URL + "Save & test connection" (`GET /api/health`).
   Shown first if no auth token is stored yet.
2. **Login / Signup** — toggle between the two; signup also asks for a
   display name.
3. **Search** — query, optional min-seeders / max-size filters, sort
   (seeders / size / date), focusable result list with an "Add" button per
   result (only shown for results with a magnet link).
4. **Downloads / Queue** — job list with a status pill and progress bar;
   polls `POST /api/downloads/:id/refresh` every 4s for jobs still
   `queued`/`downloading`; "Play" appears once a job is `finished`; per-job
   refresh and remove actions.
5. **Player** — full-screen `react-native-video` playback of the resolved
   `streamUrl`.

## Project layout

```
App.tsx                   screen state machine wiring the 5 screens together
index.js, app.json         RN entry point / app name
src/api.ts                 fetch wrapper, AsyncStorage-backed server URL + JWT
src/theme.ts                colors, type styles, box-drawing helpers
src/format.ts                human-readable byte sizes
src/components/            Panel, TvButton, TvTextInput, Scanlines, Cursor,
                            StatusPill/ProgressBar, TopNav
src/screens/                SettingsScreen, AuthScreen, SearchScreen,
                            DownloadsScreen, PlayerScreen
```

## Configuring the server

The server base URL defaults to `http://192.168.1.50:61337` and is editable
from the in-app Settings screen (persisted in AsyncStorage, no rebuild
needed to point at a different Phosphor instance). "Save & test connection"
calls the server's public `GET /api/health` before storing the URL.

## Run it

This repo ships JS/TS sources only — no native `android/` project is
checked in. Generate one, once, from the react-native-tvos template, then
drop this app's sources into it:

```bash
cd phosphor/tv/android-tv
npm install

# One-off: scaffold native projects for the TV target into a sibling
# directory, then copy this repo's App.tsx / index.js / app.json / src/
# over the generated ones (keep the generated android/ and ios/ as-is).
npx @react-native-community/cli init PhosphorTV --template react-native-tvos
# ...copy App.tsx, index.js, app.json, src/, babel.config.js,
#    metro.config.js, tsconfig.json from this directory into PhosphorTV/,
#    then work from PhosphorTV/ (or copy PhosphorTV/android + PhosphorTV/ios
#    back into this directory — either layout works, just keep the native
#    project's app name/getMainComponentName in sync with app.json).

npm run android    # with an Android TV emulator or Fire TV connected via adb
```

For a physical Fire TV / Android TV device: enable ADB debugging on the
device, then:

```bash
adb connect <tv-ip>:5555
npm run android
```

Set `android:banner` in the manifest and keep the `LEANBACK_LAUNCHER`
intent filter so the app shows up in the TV launcher — both are included
by the react-native-tvos template's generated `AndroidManifest.xml`.

## Typecheck

```bash
npx tsc --noEmit
```

## What's intentionally not here

Admin functionality (managing indexers, users, server-wide settings) is
web-only for this project — there is no admin UI on TV, matching the
mobile/desktop clients.
