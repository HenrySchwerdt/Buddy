# Buddy

An extensible, open-source automated insulin delivery **research app** for iOS and Android,
built with React Native / Expo (TypeScript) as a port of [Trio](https://github.com/nightscout/Trio).

> ⚠️ **Not a medical device.** Read [DISCLAIMER.md](DISCLAIMER.md). Buddy ships with a virtual
> patient, pump and CGM only.

## What's inside

| Package | What it does |
| --- | --- |
| [`packages/core`](packages/core) | Domain types, insulin/carb models, the **SafetyGuard**, plugin contracts, registry, LoopEngine |
| [`packages/algorithms`](packages/algorithms) | Dosing algorithms as plugins + a conformance test kit |
| [`packages/simulator`](packages/simulator) | Hovorka virtual patients, scenarios, consensus CGM metrics, benchmark CLI |
| [`packages/devices`](packages/devices) | Pump/CGM plugins (BLE drivers in TypeScript), shadow mode, BLE test kit + pump contract |
| [`apps/mobile`](apps/mobile) | The Expo app (Home, Treatments, History, Adjustments, Settings, Onboarding) |

### Algorithms

| id | Name | Doses with |
| --- | --- | --- |
| `oref-smb` | oref SMB (Trio) — TypeScript port of Trio's `determine-basal.js`, byte-identical | temp basal + SMB, UAM |
| `oref-temp-basal` | oref with SMB/UAM off (classic AMA) | temp basal |
| `predictive` | Loop-style forecast-to-target (clean-room) | temp basal or partial auto-bolus |
| `pid-ifb` | PID with insulin feedback and anti-windup | temp basal |

### Devices

| Kind | Plugins |
| --- | --- |
| Pumps | Demo pump (virtual patient), Follow Trio via Nightscout (shadow mode, read-only), Dana-i / Dana RS, Medtrum Nano, Omnipod DASH, Omnipod Classic (Eros) via RileyLink, Medtronic MiniMed via RileyLink, Accu-Chek Insight via InsightBridge |
| CGMs | Demo CGM, Nightscout, Dexcom Share, Dexcom G5 / G6, Dexcom G7, Libre 1 / 2 (direct or transmitter), Libre 3 direct (needs your own app credential) and via LibreLinkUp, Syai Ultra, xDrip4iOS (iOS app group) / xDrip+ (Android broadcast) |

Not supported: Eversense and Accu-Chek SmartGuide. Their Swift kits carry no licence, so neither code nor artwork is used. MiniMed is ported from the MIT-licensed rileylink_ios code that MinimedKit was migrated from.

Hardware drivers are TypeScript ports of the Swift drivers Trio uses (DanaKit, MedtrumKit, OmnipodKit, RileyLinkKit,
MinimedKit / rileylink_ios, InsightKit, RoundWhiteDiscKit / LibreLoop, SyaiKit) and are
**experimental**: verified against protocol simulators and the original test vectors, not yet
on hardware.

## User interface

- **iOS** follows Trio dev 1:1: same screens, copy and order, using SwiftUI controls through
  `@expo/ui` where Trio does.
- **Android** uses the same Trio look. Where iOS uses a native-only control (action sheet,
  alert, wheel, switch, slider, page sheet), Android draws a JS twin of the iOS control
  (`trio/choice-dialog.tsx`, `trio/switch.tsx`, `trio/slider.tsx`, `trio/sheet-modal.tsx`).
  SF Symbols map to Material Symbols (`trio/symbol-map.ts`, covered by
  `trio/__tests__/symbol.test.ts`).
- The Lab (algorithm benchmark on virtual patients) is CLI only: `pnpm sim`.

See [docs/UI-PORTING.md](docs/UI-PORTING.md).

## Closed loop gate

Closed loop only runs when `closedLoopBlockReason()`
(`apps/mobile/src/runtime/closed-loop-gate.ts`) returns `null`; otherwise Buddy stays in open
loop. As in Trio, any pump and CGM may loop. It blocks only when:

1. pump or CGM is missing;
2. the pump is read-only (shadow mode, "Follow Trio");
3. a real pump is paired with the simulated CGM.

## Quick start

```bash
pnpm install
npx vitest run       # all tests: core, safety, algorithms, simulator, devices, app logic
pnpm sim             # benchmark every algorithm on the virtual cohort (CLI)
```

### Dev builds (`apps/mobile`)

Expo Go is not enough (native modules); build a dev client.

```bash
cd apps/mobile
npx expo run:ios        # needs Xcode
npx expo run:android    # needs JDK 17 or 21 and the Android SDK
```

- **iOS and Xcode 26:** `pnpm install` applies `patches/expo-modules-jsi@58.0.23.patch`
  (configured under `pnpm.patchedDependencies` in `package.json`). It makes
  `expo-modules-jsi` compile with Xcode 26.3's stricter isolation checker. Run `pnpm install`
  again after touching the patch.
- **Android:** Gradle needs JDK 17 or 21, and the system default may be newer. Use Android
  Studio's bundled JBR, for example:

  ```bash
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  npx expo run:android
  ```

### Tests and type checks

```bash
npx vitest run                      # from the repo root
cd apps/mobile && npx tsc --noEmit  # app type check (root: pnpm typecheck runs both)
```

## Architecture in one picture

```
CGM plugin ─┐                       ┌──────────────┐
            ├─► LoopEngine ─► input ─► Algorithm    │  (pure function, any plugin)
Pump plugin ┘      ▲                 └──────┬───────┘
     ▲             │                        ▼
     │        DataStore            SafetyGuard (hard limits, algorithm-agnostic)
     └──────── enact (closed loop only) ◄───┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ADDING_AN_ALGORITHM.md](docs/ADDING_AN_ALGORITHM.md)
and [docs/ADDING_A_DEVICE.md](docs/ADDING_A_DEVICE.md).

## Licensing

Buddy's own code is released under the [MIT License](LICENSE). It is a derivative work in
several places, so the facts are listed here (checked against a local checkout of Trio dev,
`git` HEAD `9130fc8e3`, on 2026-11-25):

| Part of Buddy | Derived from | Upstream license found |
| --- | --- | --- |
| `packages/algorithms/src/oref/engine` (TypeScript port of `determine-basal.js` and friends) | oref0 via `trio-oref` | MIT; the notice is kept in `packages/algorithms/src/oref/LICENSE-oref` |
| `packages/devices` Dana / Medtrum drivers | DanaKit, MedtrumKit (Swift) | MIT (`DanaKit/LICENSE`, `MedtrumKit/LICENSE` in the Trio tree) |
| `packages/devices` Omnipod (DASH, Eros) and RileyLink drivers | OmnipodKit, RileyLinkKit (Swift) | MIT (`OmnipodKit/LICENSE`, `RileyLinkKit/LICENSE`) |
| `packages/devices` Libre 3 and Syai drivers | RoundWhiteDiscKit, LibreLoop, SyaiKit (Swift) | MIT (`RoundWhiteDiscKit/LICENSE`, `LibreLoop/LICENSE`, `SyaiKit/LICENSE`) |
| `apps/mobile/src/features/devices/images` | device artwork of the MIT kits above, plus original drawings | see `NOTICE` |
| `apps/mobile` screens, layout, behaviour and defaults (iOS UI is a 1:1 port) | Trio dev app (SwiftUI) | Trio's top-level `LICENSE.txt`: MIT, Copyright (c) 2021 Ivan Valkou |
| `apps/mobile/src/features/settings/trio-copy.ts`, `features/onboarding/texts.ts` and other help texts | Trio dev help texts, mostly verbatim | same as the line above |
| `docs/trio-reference/*.png` | screenshots of the Trio dev UI | same as the line above (screenshots, not code) |

Findings and the open question:

- Trio is **MIT-licensed, not AGPL-3.0**: both the fork that was ported from and the upstream
  `nightscout/Trio` checkout carry the same `LICENSE.txt` (MIT, Copyright (c) 2021 Ivan Valkou).
  No AGPL or GPL text exists in the tree; bundled sub-projects carry their own MIT or
  BSD-2-Clause files.
- Trio's `ACKNOWLEDGEMENTS.md` lists non-code assets under other terms (alarm sounds CC0,
  Amy voice CC BY-SA 4.0, Bryce voice public domain). Buddy does not bundle any of these audio
  files.
- MIT requires keeping the copyright notice with substantial portions. The Trio notice is
  reproduced in [`NOTICE`](NOTICE) (and for the oref engine in `LICENSE-oref`).
- Not reviewed: the licenses of Trio sub-projects beyond the headers listed above, and any
  contribution terms of the Trio project.

This section states facts and an open question, not legal advice. Have the license situation
of the UI and text port reviewed before any public distribution.
