# Porting Trio dev's UI to Buddy

**iOS** is a 1:1 port of Trio dev (1.0.2.88): screens, behaviour, validation, defaults, copy and
order match. **Android** shows the same Trio look from the same code (see "Android" below);
there is no separate Android app. Two references for the iOS side:

- **Screenshots:** `docs/trio-reference/*.png` (iPhone 17, dark mode, 1206×2622 px = 3× of
  402×874 pt). Measure in points (px ÷ 3).
- **Source:** a local Trio dev checkout, `Trio/Sources` (SwiftUI). Read the view *and* its
  StateModel so behaviour, validation, defaults, copy and order match. Keep Trio's English
  texts, but replace "Trio" with "Buddy" where the text means the running app, and make every
  "Default: ..." claim state **Buddy's** real default (see "Help texts" below).

## UI kit — always use it (`apps/mobile/src/trio`)

| Trio / SwiftUI | Buddy |
| --- | --- |
| `List` + `Section` + `.listRowBackground(Color.chart)` | `<Section header footer>` |
| `NavigationLink` row | `<NavRow>` |
| `LabeledContent` / value row | `<ValueRow>` |
| `Toggle` | `<ToggleRow>` |
| `Picker(.menu)` (tinted value + ⌃⌄) | `<PickerRow>` |
| `TextFieldWithToolBar` numeric entry | `<InputRow>` |
| checkbox / radio rows | `<CheckboxRow>` / `<RadioRow>` |
| `Picker(.segmented)` | `<Segmented>` |
| toolbar `.glass` capsule buttons ("Close", "Presets +") | `<CapsuleButton>` |
| big blue full-width button | `<PrimaryButton>` |
| `.glassPanel(tint:)` | `<GlassPanel tint>` |
| `Text(...).font(.headline).fontDesign(.rounded)` | `<T style_="headline" rounded>` |
| NavigationStack screen with large title | `<TrioScreen title back trailing>` |
| sheet with Close/Title/Action header | `<SheetScreen title leading trailing footer>` |
| colours (`Color.insulin`, `.tabBar`, `.chart`, …) | `useTrioColors()` (Trio palette on iOS, `MD_DARK` / `MD_LIGHT` on Android) |
| SF Symbol | `<SymbolView name="...">` (`trio/symbol.tsx`); write the SF name, Android uses `trio/symbol-map.ts` |
| `confirmationDialog` / action sheet | `choose()` from `trio/choice-dialog.tsx` |

Do not use the older components in `src/components` or `src/theme` for new work.

## Android (same Trio look)

Screens are written once in Trio's SwiftUI vocabulary and look the same on Android:

- **Colours and type:** Trio's palette and type scale on both platforms (`trio/colors.ts`,
  `trio/text.tsx`); rounded numbers use Nunito on Android in place of SF Rounded.
- **iOS-only controls get JS twins drawn like the iOS control:** action sheet and alert
  (`trio/choice-dialog.tsx`, which also replaces `Alert.alert`/`Alert.prompt` on Android),
  switch (`trio/switch.tsx`), slider (`trio/slider.tsx`), page sheets (`trio/sheet-modal.tsx`),
  wheels (`trio/android-pickers.tsx`). iOS keeps the native controls.
- **`.android.tsx` twins** that Metro picks on Android: `app/(tabs)/_layout.android.tsx` (Trio's
  floating tab bar with the centre treatment button) and
  `features/adjustments/components/native.android.tsx`. A twin must keep the exports and props
  of the iOS file.
- **Icons:** `trio/symbol-map.ts` maps each SF Symbol name to a Material Symbol. Using a new SF
  Symbol anywhere in `src` requires a map entry; `trio/__tests__/symbol.test.ts` fails otherwise.
- Copy that names the system settings app uses `SYSTEM_SETTINGS` (`features/platform-copy.ts`).

Build and run: see the dev-build section in the [README](../README.md).

## Help texts and defaults

`features/settings/trio-copy.ts` (settings) and `features/onboarding/texts.ts` (onboarding) hold
Trio's help texts. Their `Default: ...` lines must match what Buddy really does, which can
differ from Trio (for example Max IOB, Max Basal, Minimum Safety Threshold, SMB with COB and
UAM). Buddy's defaults come from `packages/core/src/defaults.ts`, the oref plugins in
`packages/algorithms/src/oref/plugins.ts`, `runtime/settings-store.ts` and
`features/treatment/settings-store.ts`. When you change a default, update the text;
`features/settings/__tests__/trio-copy-defaults.test.ts` compares the two.

## Data and logic

- Live data: `useSnapshot()`, `useLiveState()` (`src/runtime/hooks.ts`); runtime actions in
  `src/runtime/runtime.ts` (`runLoop`, `deliverBolus`, `logCarbs`, `setPumpSuspended`,
  `importNightscoutProfile`, `currentPump`, `restartRuntime`, `now`).
- Settings: `useSettings` (`src/runtime/settings-store.ts`) — read freely, write via `update()`
  / `setAlgorithmSettings()` / `setDeviceSettings()`. Avoid growing it: new persisted settings
  go into a store in your feature folder
  (`create(persist(..., { name: 'buddy.<feature>.v1', storage: createJSONStorage(() => Storage) }))`
  with `Storage` from `expo-sqlite/kv-store`).
- Core logic (`packages/core`): `recommendBolus`, `effectiveSettings`, adjustments,
  `computeGlucoseStats`, `agpPercentiles`, `insulinStats`, `dailyBreakdown`, alerts.
  Put pure calculations you port from Trio into your feature folder as plain TS with vitest
  tests under `apps/mobile/src/features/<feature>/__tests__/*.test.ts` **only if** they are
  substantial (bolus calculator, FPU conversion); otherwise keep them small and typed.
- Times: always `now()` from the runtime (demo mode runs on simulated time), never `Date.now()`.

## Where things live

| Area | Owns |
| --- | --- |
| Home | `app/(tabs)/index.tsx`, `features/home/**`, `app/loop.tsx`, `app/legend.tsx` |
| Treatments | `app/treatment.tsx`, `app/bolus-details.tsx`, `app/treatment-presets.tsx`, `features/treatment/**` |
| History & Statistics | `app/(tabs)/history.tsx`, `app/statistics.tsx`, `app/add-glucose.tsx`, `features/history/**`, `features/stats/**` |
| Adjustments | `app/(tabs)/adjustments.tsx`, `app/override-editor.tsx`, `app/temp-target-editor.tsx`, `features/adjustments/**`, `packages/core/src/adjustments.ts`, override mapping in `packages/algorithms/src/oref/adapter.ts` |
| Settings A | `app/(tabs)/settings/index.tsx`, `therapy*.tsx`, `algorithm*.tsx`, `features*.tsx`, `units-limits.tsx`, `features/settings/**` |
| Settings B | `app/(tabs)/settings/notifications*.tsx`, `services*.tsx`, `nightscout*.tsx`, `export*.tsx`, `features/settings-b/**` |
| Devices | `app/add-pump.tsx`, `app/add-cgm.tsx`, `app/pump-settings.tsx`, `app/cgm-settings.tsx`, `app/(tabs)/settings/device*.tsx`, `app/(tabs)/settings/medtrum-patch.tsx`, `features/devices/**` |
| Onboarding | `app/onboarding/**`, `features/onboarding/**` |

Routes are registered in `app/_layout.tsx` (root sheets); the settings stack is generic, so
new files under `app/(tabs)/settings/` work without editing a layout.

## Done means

`cd apps/mobile && npx tsc --noEmit` is clean, `cd ../.. && npx vitest run` passes, iOS screens
match the reference screenshots in layout, spacing, copy and behaviour, and the Android twin
or branch still renders the same content. List anything you could not match and why.
