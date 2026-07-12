# StreamRD Mobile (iOS & Android)

Cross-platform Expo / React Native client for the StreamRD backend.

## Features

- Login / signup against your self-hosted server
- Netflix-style catalog rows, title detail, in-app playback (`expo-av`)
- Settings: server URL (LAN / reverse proxy / VPN) with connectivity test,
  per-user debrid provider selection and API keys
- Admins see an extra server-health tab (full admin controls are web-only)

## Run in a simulator/emulator

```bash
cd mobile
npm install
npm start          # Expo dev server; press i for iOS sim, a for Android emu
```

Requirements: Node 18+, and Xcode (iOS) or Android Studio (Android), or the
Expo Go app on a physical device on the same network.

On first launch, open **Server settings** on the login screen and point the
app at your backend (e.g. `http://192.168.1.50:4000`). The Android emulator
reaches your host machine at `http://10.0.2.2:4000`.

## Build installable binaries (APK / IPA)

The scaffold is EAS-ready:

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview   # APK for sideloading
eas build --platform ios                          # requires an Apple developer account
```

For a fully local Android build: `npx expo prebuild && cd android && ./gradlew assembleRelease`.

## Notes

- All requests go through `src/api.ts`; the JWT is stored with AsyncStorage.
- HTTP (non-TLS) LAN URLs work in dev; for production builds prefer HTTPS via
  the reverse proxy, or add ATS/cleartext exceptions for your LAN host.
