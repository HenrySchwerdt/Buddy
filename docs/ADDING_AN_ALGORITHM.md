# Adding an algorithm

An algorithm is one object implementing `AlgorithmPlugin`. It is a pure function from an
input snapshot to a decision; the LoopEngine and SafetyGuard do everything else.

## 1. Write it

`packages/algorithms/src/my-algo/index.ts`:

```ts
import { defineAlgorithm, scheduleValueAt } from '@buddy/core';
import { predictGlucose } from '../shared/predict';

export const myAlgo = defineAlgorithm({
  meta: {
    id: 'my-algo',                      // kebab-case, unique
    name: 'My algorithm',
    shortName: 'Mine',
    description: 'One sentence users will see in Settings.',
    version: '0.1.0',
    author: 'you',
    maturity: 'experimental',           // hidden unless developer mode is on
    capabilities: { tempBasal: true, autoBolus: false, predictions: ['main'] },
  },
  settings: [
    { title: 'Tuning', fields: [
      { kind: 'number', key: 'aggressiveness', label: 'Aggressiveness', min: 0.5, max: 2, step: 0.1, affectsDosing: true },
    ] },
  ],
  defaultSettings: { aggressiveness: 1 },
  decide(input, s) {
    const basal = scheduleValueAt(input.profile.basal, input.now);
    const isf = scheduleValueAt(input.profile.isf, input.now);
    const main = predictGlucose(input, { horizonMinutes: 180, momentumMinutes: 15 });
    const error = main.at(-1)! - 110;
    const rate = Math.max(0, basal + (error / isf) * s.aggressiveness);
    return { tempBasal: { rate, durationMin: 30 }, predictions: { main }, reason: `eventual ${main.at(-1)} → ${rate.toFixed(2)} U/h` };
  },
});
```

The settings schema is all the UI you need: Settings → Algorithm renders it automatically.

## 2. Register it

Add it to `BUILT_IN_ALGORITHMS` in `packages/algorithms/src/index.ts`.

## 3. Test it

`checkConformance(plugin)` runs shared scenarios every algorithm must pass (adds insulin
when high, never when low, reduces when dropping fast, calm in range, respects IOB,
deterministic, finite). The conformance and cohort-guardrail tests pick up every entry of
`BUILT_IN_ALGORITHMS` automatically:

```bash
pnpm test                         # conformance + cohort guardrails for all algorithms
pnpm sim --algo my-algo           # benchmark on the virtual cohort
```

`pnpm sim` prints TIR / TBR / TAR, CV, GMI, LBGI/HBGI and insulin per scenario for every
algorithm, so you can compare against oref and the others (there is no Lab screen in the app).

Run all tests with `npx vitest run` from the repo root. After changing algorithm settings
schemas, also run `cd apps/mobile && npx tsc --noEmit`.

If your algorithm should appear under Trio's Algorithm settings screens (Autosens, SMB,
Target Behavior, ...), those screens are bound to the oref plugins' keys
(`useOrefValues` in `apps/mobile/src/features/settings/bindings.ts`); other plugins use the
generic schema form. Help texts that state defaults live in
`apps/mobile/src/features/settings/trio-copy.ts` and are checked against the code constants by
`features/settings/__tests__/trio-copy-defaults.test.ts`, so update both when you change a default.

## Rules

- `decide` must be synchronous, deterministic and free of side effects.
- Never assume your output is enacted as is: the SafetyGuard may clamp or override it.
- Prefer returning `predictions` and a clear `reason`; users see both.
