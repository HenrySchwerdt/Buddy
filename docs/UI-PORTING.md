# Porting Trio dev's UI to Buddy (1:1)

Goal: Buddy's screens and functionality match **Trio dev 1.0.2.88** one to one; optimisation
comes later. Two references, use both:

- **Screenshots:** `docs/trio-reference/*.png` (iPhone 17, dark mode, 1206×2622 px = 3× of
  402×874 pt). Measure in points (px ÷ 3).
- **Source:** `~/dev/trio-ui/Trio/Sources` (SwiftUI). Read the view *and* its StateModel so
  behaviour, validation, defaults, copy and order match. Keep Trio's English texts verbatim.

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
| colours (`Color.insulin`, `.tabBar`, `.chart`, …) | `useTrioColors()` |

Do not use the older components in `src/components` or `src/theme` for new work.

## Data and logic

- Live data: `useSnapshot()`, `useLiveState()` (`src/runtime/hooks.ts`); runtime actions in
  `src/runtime/runtime.ts` (`runLoop`, `deliverBolus`, `logCarbs`, `setPumpSuspended`,
  `importNightscoutProfile`, `currentPump`, `restartRuntime`, `now`).
- Settings: `useSettings` (`src/runtime/settings-store.ts`) — read freely, write via `update()`
  / `setAlgorithmSettings()` / `setDeviceSettings()`. **Do not edit settings-store.ts.** New
  persisted settings go into your own store in your feature folder
  (`create(persist(..., { name: 'buddy.<feature>.v1', storage: createJSONStorage(() => Storage) }))`
  with `Storage` from `expo-sqlite/kv-store`).
- Core logic (`packages/core`): `recommendBolus`, `effectiveSettings`, adjustments,
  `computeGlucoseStats`, `agpPercentiles`, `insulinStats`, `dailyBreakdown`, alerts.
  Put pure calculations you port from Trio into your feature folder as plain TS with vitest
  tests under `apps/mobile/src/features/<feature>/__tests__/*.test.ts` **only if** they are
  substantial (bolus calculator, FPU conversion); otherwise keep them small and typed.
- Times: always `now()` from the runtime (demo mode runs on simulated time), never `Date.now()`.

## File ownership (parallel work — touch only your files)

| Area | Owns |
| --- | --- |
| Home (done) | `app/(tabs)/index.tsx`, `features/home/**`, `app/loop.tsx`, `app/legend.tsx` |
| Treatments | `app/treatment.tsx`, `app/bolus-details.tsx`, `app/treatment-presets.tsx`, `features/treatment/**` |
| History & Statistics | `app/(tabs)/history.tsx`, `app/statistics.tsx`, `app/add-glucose.tsx`, `features/history/**`, `features/stats/**` |
| Adjustments | `app/(tabs)/adjustments.tsx`, `app/override-editor.tsx`, `app/temp-target-editor.tsx`, `features/adjustments/**`, `packages/core/src/adjustments.ts`, override mapping in `packages/algorithms/src/oref/adapter.ts` |
| Settings A | `app/(tabs)/settings/index.tsx`, `therapy*.tsx`, `algorithm*.tsx`, `features*.tsx`, `units-limits.tsx`, `features/settings/**` |
| Settings B | `app/(tabs)/settings/notifications*.tsx`, `services*.tsx`, `nightscout*.tsx`, `export*.tsx`, `features/settings-b/**` |
| Devices | `app/add-pump.tsx`, `app/add-cgm.tsx`, `app/pump-settings.tsx`, `app/cgm-settings.tsx`, `app/(tabs)/settings/device*.tsx`, `app/(tabs)/settings/medtrum-patch.tsx`, `features/devices/**` |
| Onboarding | `app/onboarding/**`, `features/onboarding/**` |

Routes are already registered in `app/_layout.tsx` (root sheets) and the settings stack is
generic, so new files under `app/(tabs)/settings/` work without editing a layout. If you need
something outside your files, stop and report it.

## Done means

`cd apps/mobile && npx tsc --noEmit` is clean for your files, `cd ../.. && npx vitest run` passes,
and your screens match the reference screenshots in layout, spacing, copy and behaviour.
List in your report anything you could not match and why.
