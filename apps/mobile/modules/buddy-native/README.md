# buddy-native

Local Expo module plus its config plugin (`plugins/with-buddy-native.js`) and the Live Activity extension
(`targets/live-activity`). Everything OS-integrated that Trio does in the background lives here. JS side:
`src/runtime/background*.ts`, `live-activity*.ts`, `shortcuts*.ts`; screens `app/shortcut.tsx`,
`settings/features-shortcuts.tsx`, `settings/notifications-live-activity.tsx`.

## What runs where

| Feature | iOS | Android |
| --- | --- | --- |
| Keep looping in the background | Bluetooth background mode + CoreBluetooth state restoration (`background-ble.ts`), periodic background task | Foreground service (`BuddyForegroundService`, a `HeadlessJsTaskService`) with an ongoing notification, periodic background task |
| Glucose / IOB / COB on the lock screen | ActivityKit Live Activity + Dynamic Island (`targets/live-activity`) | The same ongoing notification |
| Shortcuts | App Intents (`plugins/buddy-native/ios/BuddyAppIntents.swift`) -> `buddy://` deep links | Static + dynamic app shortcuts -> `buddy://` deep links |

## Safety

A shortcut, App Intent, app shortcut or `buddy://shortcut?...` link only describes an action. The confirmation
screen (`src/app/shortcut.tsx`) shows it and only its button executes it, after `validateBolusSafety`
(`source: 'app'`: max bolus, IOB availability, max IOB, recent bolus) and the "Allow Bolusing with Shortcuts"
switch were checked again. Overrides, temp targets and carbs are confirmed too, because in closed loop they change
insulin delivery. The only action without a confirmation is "List State" (read-only) and "Restart Live Activity".

## Limits (be honest with users)

iOS
- Buddy cannot run a 5-minute timer in the background. It stays alive only while CoreBluetooth has work (a connected
  CGM/pump that notifies) and iOS did not terminate it. After a memory termination iOS relaunches it for Bluetooth
  events thanks to state restoration; after a force quit (swipe away) it does not.
- Background tasks (`expo-background-task`) are scheduled by iOS: roughly every 15 minutes at best, often much less,
  none in Low Power Mode. They are a safety net, not a scheduler. Closed loop with a Bluetooth CGM works because
  of the Bluetooth wake-ups; with a polled source (Nightscout, LibreLinkUp, xDrip app group) Buddy only updates when
  it is open or when iOS grants a background task.
- No audio/silent-track or location tricks are used (not allowed by App Store rules, and unreliable).
- A Live Activity can only be started while the app is in the foreground and iOS ends it after 8 hours (12 h on the
  lock screen). Buddy restarts it when you open the app after 7.5 h, or from the "Restart Live Activity" button or
  shortcut. Updates come from the running app (no push), so the activity is as fresh as the app's last wake-up; it
  goes grey ("Old") 15 minutes after the last reading. Live Activities must be allowed in iOS Settings.
- Trio's "glucose forecasts" in the Live Activity and the Watch / CarPlay smart stack style are not implemented.
- The widget extension needs a signing team to run on a device: set `ios.appleTeamId` in app.json. The simulator
  builds without it.
- App Intents run `openAppWhenRun`: iOS opens Buddy, which shows the confirmation screen. Intents cannot deliver
  insulin from the background by design.

Android
- The foreground service starts only when the app is in the foreground (Android 12+ forbids starting one from the
  background) and a real pump/CGM is configured; after a process kill Android restarts it itself
  (`START_REDELIVER_INTENT`) and its headless task boots the runtime without UI.
- Type `connectedDevice` needs a granted Bluetooth permission; without one it falls back to `specialUse`. Neither has
  Android 15's `dataSync` time limit. Some vendors (Xiaomi, Huawei, Samsung "sleeping apps") still kill the app: set
  battery use to "Unrestricted". Swiping the app away may stop the service on those devices.
- The service holds a partial wake lock while it runs (React Native's headless task does that): expect battery cost.
- Foreground services are not restarted after a reboot (no BOOT receiver; Android 12+ forbids starting them from one).
  Open Buddy once after rebooting.
- The notification needs the notification permission to be visible; the service runs without it.

## Verified vs. not

See the report of the change that added this module; native code was compiled for iOS (simulator) and Android,
but the Live Activity, App Intents, foreground service and background task were not exercised on a device.
