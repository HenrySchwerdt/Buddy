# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **example** directory and create a blank **src/app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.

## xDrip CGM source (xDrip4iOS / xDrip+)

Buddy can take glucose from the xDrip app on the same phone, like Trio's "xDrip4iOS" CGM option. Native code lives in the local Expo module `modules/xdrip-bridge` (autolinked by `expo prebuild`; never edit the generated `ios/` and `android/` folders) and the config plugin `plugins/with-xdrip.js`. The device logic is pure TypeScript in `packages/devices/src/xdrip`.

**iOS (xDrip4iOS).** xDrip4iOS shares its latest readings as JSON in the App Group UserDefaults (key `latestReadings`), and Buddy reads that key. Both apps must use the same App Group, therefore be signed by the same Apple developer team. Set it in `app.json`:

```json
["./plugins/with-xdrip", { "developmentTeam": "ABCDE12345" }]
```

- `developmentTeam` (10 characters) derives Trio's group id, `group.org.nightscout.<TEAM>.trio.trio-app-group`.
- `appGroupId` sets the full id instead (wins over `developmentTeam`), e.g. `group.com.example.shared`.
- Environment fallbacks: `BUDDY_XDRIP_APP_GROUP_ID`, `BUDDY_DEVELOPMENT_TEAM`.
- The default `XXXXXXXXXX` is a placeholder; the source then reports "not configured" instead of reading anything.

The plugin adds the `com.apple.security.application-groups` entitlement, the Info.plist key `AppGroupID` (same name Trio uses) and `xdripswift` to `LSApplicationQueriesSchemes`. The App Group must also be registered for the Buddy app id in your Apple developer account. In xDrip4iOS, turn on the sharing that Trio uses (Settings, Trio / Loop share) so it writes to that group. Run `expo prebuild` and build a development build afterwards (Expo Go cannot load the module).

**Android (xDrip+).** In xDrip+ enable Settings > Inter-app settings > "Broadcast locally" and make sure Buddy's `dev.buddy.app` is allowed to receive it. The module declares a manifest receiver for `com.eveningoutpost.dexdrip.BgEstimate` (so readings also arrive while Buddy is in the background), keeps the latest 120 readings and emits `onReading` events. No configuration is needed. Note that any app on the phone can send that broadcast; Buddy only checks plausibility and timestamps, so treat the source as experimental.

Readings keep xDrip's own measurement time, duplicates are dropped by timestamp, readings dated more than 60 s in the future are rejected, and nothing is invented: if xDrip stops delivering, the newest reading just gets old.

## Services and remote control

Everything below is research software. It sits behind switches that are off by default.

### Nightscout fetch, upload extras

- **Settings > Services > Nightscout > Fetch** reads carbs and temp targets that were entered in Nightscout (not by Buddy, Trio, AAPS, iAPS or Loop) about once a minute. The newest running temp target becomes active; a "Cancel" in Nightscout ends it.
- **Upload** also sends the therapy profile (on connect and whenever profile, units or override presets change), phone battery in the device status, and, with "Upload CGM Sensor States", sensor session starts. A CGM driver reports its session by implementing an optional `sensorSession(): { startedAt, transmitterId?, activatedAt? } | null`; drivers without it upload no sensor notes.
- `deleteRecordEverywhere(kind, id, date)` in `src/runtime/record-deletion.ts` removes a glucose reading, carb entry or dose locally and from Nightscout, Apple Health / Health Connect and Tidepool (each only when switched on).

### Apple Health, Health Connect, Calendar, badge, Face ID

- **Apple Health** (iOS, `@kingstinct/react-native-healthkit`) writes glucose, carbs and insulin (boluses, SMBs, external insulin and settled temp basals). **Health Connect** (Android, `react-native-health-connect`, minSdk 26) writes glucose and carbs; it has no insulin record. Dev client or release build only (not Expo Go).
- **Calendar events** (`expo-calendar`) keep one event with the current glucose (optional emojis, IOB and COB).
- **Glucose app badge** shows the glucose on the app icon (mmol/L as value x 10, like Trio).
- A manual pump bolus asks for Face ID, fingerprint or the device passcode first (`expo-local-authentication`). The demo world skips the prompt. Carbs and external insulin do not ask.

### Tidepool

Buddy has no registered Tidepool OAuth client. Register one with Tidepool, using the redirect address shown on **Settings > Services > Tidepool** (`buddy://tidepool-auth`), then type its client id into that screen. Do not reuse another app's client id. Sign-in uses the system browser (PKCE); tokens stay in the keychain.

### Remote control

Buddy accepts the same encrypted commands as Trio's remote control: bolus, meal, edit/delete meal, temp target, override start/cancel. Everything is checked before it runs:

- AES-256-GCM message, key = SHA-256 of the shared secret (**Settings > Features > Remote Control**, stored in the keychain), 12 byte nonce in front of the ciphertext and tag, base64.
- The command timestamp must be within 10 minutes of now (past and future); a `command_id` is executed only once.
- Boluses go through the bolus safety validator with the command time as look-back start (max bolus, max IOB, IOB known, no significant bolus since the command was sent); meals check max carbs/fat/protein and newer carb entries; temp targets and overrides are range-checked.
- A rejected command is never executed. The rejection (without any secret) is logged, uploaded as a Nightscout note when upload is on, and shown as a local notification.

What Buddy does **not** ship, and what you must provide for push delivery:

1. **A way to send pushes.** The sender (for example Loop Follow) needs credentials that can push to this app: an APNs auth key (`.p8`) of your Apple developer team for the app's bundle id (iOS), or Firebase Cloud Messaging for Android. Buddy holds no server or credentials.
2. **iOS:** set `ios.appleTeamId` in `app.json`, and in the `expo-notifications` plugin entry set `"enableBackgroundRemoteNotifications": true` so a silent push (`content-available: 1`) can wake the app. Build with the Push Notifications capability. With remote control on, Buddy writes its APNs device token, bundle id, team id and the supported command list into the Nightscout profile, where Loop Follow reads them (as Trio does).
3. **Message format:** a push whose custom data holds `{"encrypted_data": "<base64>"}`. Buddy reads it from the notification data while the app runs. For delivery in the background, a background task must call `handleRemotePushData(data)` from `src/runtime/remote-control/wiring.ts` (not wired here; the background task files belong to the background module).
4. **Android** needs `google-services.json` for FCM and a sender that posts the same JSON as an FCM data message; this path is untested.
5. Response notifications to the sender (Trio's return notification signed with the sender's APNs key) are not implemented. The result stays on the phone.
