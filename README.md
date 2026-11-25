# Buddy

An extensible, open-source automated insulin delivery **research app** for iOS and Android,
built with React Native / Expo and inspired by [Trio](https://github.com/nightscout/Trio).

> ⚠️ **Not a medical device.** Read [DISCLAIMER.md](DISCLAIMER.md). Buddy ships with a virtual
> patient, pump and CGM only.

## What's inside

| Package | What it does |
| --- | --- |
| [`packages/core`](packages/core) | Domain types, insulin/carb models, the **SafetyGuard**, plugin contracts, registry, LoopEngine |
| [`packages/algorithms`](packages/algorithms) | Dosing algorithms as plugins + a conformance test kit |
| [`packages/simulator`](packages/simulator) | Hovorka virtual patients, scenarios, consensus CGM metrics, benchmark CLI |
| [`packages/devices`](packages/devices) | Pump/CGM plugins (BLE drivers in TypeScript), shadow mode, BLE test kit + pump contract |
| [`apps/mobile`](apps/mobile) | The Expo app (Home, Lab, History, Settings) |

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
| Pumps | Demo pump (virtual patient), Follow Trio via Nightscout (shadow mode, read-only), Dana-i / Dana RS, Medtrum Nano |
| CGMs | Demo CGM, Nightscout, Dexcom Share, Dexcom G6, Dexcom G7, Libre |

Hardware drivers are TypeScript ports of the MIT-licensed Swift drivers used by Trio and are
**experimental**: verified against protocol simulators and the original test vectors, not yet
on hardware. Pumps need the in-app hardware check before closed loop.

## Quick start

```bash
pnpm install
pnpm test            # 70+ tests: core, safety, algorithms, simulator, devices
pnpm sim             # benchmark every algorithm on the virtual cohort
cd apps/mobile && npx expo run:ios     # or run:android
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
