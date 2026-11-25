# Architecture

Buddy is a pnpm monorepo. Everything that decides about insulin lives in plain TypeScript
packages with no React Native dependency, so it runs identically in the app, in unit tests
and in the benchmark CLI.

## Layers

1. **`@buddy/core`** — the contracts and the only code allowed to command insulin.
   - `types.ts`: glucose, doses, carbs, therapy profile, safety limits (mg/dL and epoch ms everywhere).
   - `insulin.ts`: oref/Loop exponential insulin curve, net-basal pulses, IOB and projections.
   - `algorithm.ts`: `AlgorithmPlugin` — `decide(input, settings) → decision`, pure and synchronous.
   - `devices.ts`: `PumpDriver`, `CgmSource` and their `DevicePlugin` factories.
   - `settings-schema.ts`: declarative settings; the app renders forms from them.
   - `safety.ts`: **SafetyGuard** — algorithm-agnostic hard limits (see below).
   - `loop.ts`: **LoopEngine** — sync devices → build input → algorithm → guard → enact.
   - `store.ts`: immutable data snapshots with subscriptions.
2. **`@buddy/algorithms`** — plugins. oref is vendored JavaScript behind an adapter.
3. **`@buddy/devices`** — pump/CGM plugins.
4. **`@buddy/simulator`** — virtual patients that implement the *same* device interfaces,
   so the real LoopEngine is exercised end-to-end in tests and in the benchmark CLI (`pnpm sim`).
   There is no Lab screen in the app.
5. **`apps/mobile`** — UI and runtime wiring (settings → plugins → engine → scheduler).
   - `src/trio/`: the UI kit. iOS renders Trio dev 1:1; Android takes Material 3 branches
     (`MD_DARK` / `MD_LIGHT` in `colors.ts`, `symbol-map.ts`, `choice-dialog.tsx`,
     `android-pickers.tsx`, `.android.tsx` twins). See [UI-PORTING.md](UI-PORTING.md).
   - `src/runtime/`: `runtime.ts` builds devices and the LoopEngine, `settings-store.ts` holds
     persisted settings, `closed-loop-gate.ts` decides whether closed loop may run.
   - `src/features/<area>/`: screens' logic and per-feature stores.

## The loop cycle

```
runOnce():
  sync      CGM.readings(since last) and Pump.history(24 h) → DataStore
  input     glucose status, IOB (from delivered history), COB, profile, limits, pump state
  decide    algorithm.decide(input, settings)            — may be wrong, never trusted
  guard     guardDecision(input, decision)               — clamps / overrides
  enact     closed loop only: temp basal, auto bolus     — only confirmed doses are stored
  record    LoopRun (suggested, guarded, enacted, interventions, timings)
```

Runs never overlap. Exceptions anywhere produce a failed `LoopRun` and **no dosing**.

## SafetyGuard rules (in order)

| Rule | Effect |
| --- | --- |
| Non-finite numbers in the decision | cancel temp, no bolus |
| Pump suspended | no commands |
| CGM older than `maxGlucoseAgeMinutes` | cancel temp, no bolus |
| BG < `suspendThreshold` or 15-min trend projects below | zero temp 30 min, no bolus |
| Temp rate | clamped to `[0, maxBasalRate]`, floored to pump increment |
| IOB ≥ `maxIOB` | no temp above scheduled basal |
| Temp duration | clamped to 1–120 min |
| Auto bolus | ≤ `maxAutoBolus`, ≤ `maxBolus`, ≤ `maxIOB − IOB`, spacing ≥ interval, not while bolusing |

The guard is covered by `packages/core/test/safety.test.ts`. Limits can only be tightened by
algorithms, never relaxed.

## Closed-loop gate

`closedLoopBlockReason(pump, cgm, hardwareChecks)` in `apps/mobile/src/runtime/closed-loop-gate.ts`
is a pure function; `runtime.ts` calls it on every engine config read, so the loop mode is
forced to `open` while it returns a reason. Checks, in order of severity:

1. no pump or no CGM configured;
2. read-only pump (`meta.readOnly`, the Nightscout follower): shadow mode never doses;
3. demo pump with a real CGM, or real pump with a simulated CGM (`maturity: 'simulator'`
   mixes are refused);
4. `meta.requiresHardwareCheck` and no completed hardware check for that pump id.

It is separate from the SafetyGuard: the gate decides *whether* the loop may enact at all, the
guard clamps *what* it enacts. Tests: `apps/mobile/src/runtime/__tests__/closed-loop-gate.test.ts`.

## Simulator

`packages/simulator` (run it with `pnpm sim`, CLI only) implements the Hovorka (2004) model with Wilinska (2010) parameters,
integrated with RK4 at 1-minute steps, a CGM with sensor lag and AR(1) noise, and a virtual
pump. Each virtual patient's "true" basal/ISF/CR are measured from the model, and scenarios
can deliberately mis-set the profile (±25 %) or hide meals to test robustness.
Metrics follow the international consensus (TIR/TBR/TAR, CV, GMI, LBGI/HBGI).

## Hardware transports

Drivers never import a native library. They receive `ctx.ble` (`BleTransport`), `ctx.nfc`
(`NfcTransport`) and `ctx.secrets` (`SecretStore`) from `@buddy/core/transport`. The app wires
these to react-native-ble-plx, react-native-nfc-manager and the keychain; tests wire them to
`createFakeBle()` plus a per-driver protocol simulator. Every pump driver must pass
`PUMP_CONTRACT` (`packages/devices/src/testkit`) against its simulator.

## Shadow mode (compare with Trio)

Select **Follow Trio (shadow mode)** as pump and Nightscout as CGM. The follower is a
read-only `PumpDriver`: its `history()` and `carbHistory()` come from the Nightscout
treatments Trio uploads, and `referenceDecision()` returns Trio's latest `openaps.enacted`
from devicestatus. The LoopEngine runs the selected Buddy algorithm on exactly the same
data, never enacts (`meta.readOnly`), and stores Trio's decision in `LoopRun.reference`.
The app shows both per cycle and summarises agreement and insulin differences. Import the
Nightscout profile first so both loops use identical therapy settings.

## Hardware check

Pump drivers ported without hardware verification set `meta.requiresHardwareCheck`.
Closed loop stays unavailable for such a pump until the in-app bench check passed (pump not
attached to anyone): status, temp basal set/cancel, 0.1 U bolus compared with the pump's own
history, suspend/resume, and a link drop during a bolus. Manual commands are not gated.

## oref engine

`packages/algorithms/src/oref/engine` is a line-by-line TypeScript port of Trio's
`determine-basal.js`. `test/oref-port.test.ts` replays 320 inputs captured from closed-loop
simulations and requires byte-identical output to the original JavaScript.

## Known simplifications

- oref's COB uses a deviation-based estimate ported in simplified form; autosens is fixed at 1.0.
- No real pump drivers ship with Buddy. The demo pump only doses a virtual patient.
