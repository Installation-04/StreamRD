# StreamRD for Android TV / Fire TV

React Native TV client built on [`react-native-tvos`](https://github.com/react-native-tvos/react-native-tvos).

## Features

- Remote-first navigation: every element is focusable with a visible focus
  ring; the platform D-pad focus engine handles movement
- Home rows, title detail, full-screen playback (`react-native-video`)
- Settings screen for server URL + connectivity test, account login

## Run it

```bash
cd tv/android-tv
npm install
# Generate native projects for the TV target (one-off):
npx react-native init-template-e2e 2>/dev/null || true
npm run android    # with an Android TV emulator or Fire TV connected via adb
```

For a device: enable ADB debugging on the TV, `adb connect <tv-ip>:5555`,
then `npm run android`.

Note: this scaffold ships JS/TS sources only; generate the `android/` native
project with `npx @react-native-community/cli init --template react-native-tvos`
(or copy one from an existing RN-TV app) before the first build. Set
`android:banner` in the manifest and the `LEANBACK_LAUNCHER` intent filter so
the app appears in the TV launcher — both are included by the RN-TV template.

Admin controls are intentionally absent on TV — use the web dashboard.
