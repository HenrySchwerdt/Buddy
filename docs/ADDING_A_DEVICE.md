# Adding a pump or CGM

Devices are `DevicePlugin`s: metadata, a settings schema, defaults and a `create()` factory
that returns a `PumpDriver` or `CgmSource`.

## CGM

```ts
import { defineCgm } from '@buddy/core';

export const myCgm = defineCgm({
  meta: { id: 'my-cgm', name: 'My CGM', manufacturer: 'Acme', description: '…', transport: 'network', maturity: 'experimental' },
  settings: [{ title: 'Account', fields: [
    { kind: 'text', key: 'url', label: 'URL' },
    { kind: 'text', key: 'token', label: 'Token', secret: true },   // stored in the keychain
  ] }],
  defaultSettings: { url: '', token: '' },
  create(settings, ctx) {
    return {
      meta: myCgm.meta,
      start: async () => {},
      stop: async () => {},
      readings: async (since) => { /* ctx.fetch(...) → GlucoseReading[] with date > since */ return []; },
    };
  },
});
```

Register it in `BUILT_IN_CGMS` (`packages/devices/src/index.ts`). Use `ctx.fetch` and
`ctx.clock` (never globals) so the driver is testable; see `packages/devices/test`.
Reject implausible values (`isPlausibleGlucose`).

## Pump

A `PumpDriver` must uphold these invariants, because IOB is computed from its history:

1. A command resolves `{ ok: true }` **only after the pump confirmed it**.
2. `history(since)` returns **only delivered insulin** (partial boluses as delivered amount).
3. `status()` reports the running temp basal, suspension and bolus-in-progress truthfully.
4. Temp basals are absolute rates (U/h); a cancel is recorded so IOB stays correct.

Drivers are plain TypeScript on top of `ctx.ble` (see `packages/core/src/transport.ts`), so
the whole protocol — framing, crypto, state machine — runs in Node tests. Write a protocol
simulator as a `FakePeripheral` and run `PUMP_CONTRACT` against your driver (see
`packages/devices/test/dana*.test.ts` / `medtrum*.test.ts`). Set `requiresHardwareCheck: true`
until the driver has been bench-verified.

Before a driver can be marked `stable` it needs: a protocol simulator for unit tests, the
`PumpDriver` contract tests, fault-injection tests (lost connection mid-bolus, unconfirmed
commands) and long-running bench testing on hardware that is not attached to a person.
