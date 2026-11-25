import type { InsulinDose, PumpDriver } from '@buddy/core';

/**
 * Behavioural contract every pump driver must satisfy, run against the driver's protocol
 * simulator. The LoopEngine computes IOB purely from `history()`, so these checks focus on
 * "only report what was really delivered" and "never throw instead of answering".
 */
export interface PumpHarness {
  readonly driver: PumpDriver;
  /** Advance simulated time (and the pump simulator) by `ms`. */
  advance(ms: number): Promise<void>;
  /** Make the BLE link drop right after the next command reaches the pump. */
  dropConnectionAfterNextCommand(): void;
  /** Units the simulated pump has actually delivered as boluses (ground truth). */
  deliveredBolusUnits(): number;
}

export interface ContractCheck {
  readonly name: string;
  run(h: PumpHarness): Promise<void>;
}

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`Pump contract: ${msg}`);
};
const bolusSum = (h: InsulinDose[]) => h.reduce((s, d) => (d.kind === 'bolus' || d.kind === 'smb' ? s + d.units : s), 0);

async function settle(h: PumpHarness) {
  for (let i = 0; i < 120; i++) {
    if (!(await h.driver.status()).bolusing) return;
    await h.advance(5_000);
  }
  throw new Error('Pump contract: bolus never finished');
}

export const PUMP_CONTRACT: readonly ContractCheck[] = [
  {
    name: 'reports a sane status after connecting',
    async run(h) {
      await h.driver.connect();
      const s = await h.driver.status();
      assert(s.bolusIncrement > 0 && s.bolusIncrement <= 0.1, `bolusIncrement ${s.bolusIncrement}`);
      assert(s.basalIncrement > 0 && s.basalIncrement <= 0.1, `basalIncrement ${s.basalIncrement}`);
      assert(s.reservoirUnits === null || (s.reservoirUnits >= 0 && s.reservoirUnits <= 400), `reservoir ${s.reservoirUnits}`);
      assert(!s.suspended, 'fresh pump should not be suspended');
    },
  },
  {
    name: 'sets, reports and cancels a temp basal',
    async run(h) {
      await h.driver.connect();
      const r = await h.driver.setTempBasal(1.5, 30);
      assert(r.ok, `setTempBasal failed: ${!r.ok && r.error}`);
      const s = await h.driver.status();
      assert(s.tempBasal && Math.abs(s.tempBasal.rate - 1.5) < 0.051, `status temp ${JSON.stringify(s.tempBasal)}`);
      const hist = await h.driver.history(0);
      assert(hist.some((d) => d.kind === 'tempBasal' && Math.abs(d.rate - 1.5) < 0.051), 'temp basal missing from history');
      const c = await h.driver.cancelTempBasal();
      assert(c.ok, 'cancelTempBasal failed');
      assert((await h.driver.status()).tempBasal === null, 'temp still running after cancel');
    },
  },
  {
    name: 'delivers a bolus and records exactly what was delivered',
    async run(h) {
      await h.driver.connect();
      const r = await h.driver.bolus(0.5, { automatic: false });
      assert(r.ok, `bolus failed: ${!r.ok && r.error}`);
      await settle(h);
      const recorded = bolusSum(await h.driver.history(0));
      assert(Math.abs(recorded - 0.5) < 0.001, `history shows ${recorded} U, expected 0.5 U`);
      assert(Math.abs(h.deliveredBolusUnits() - recorded) < 0.001, `pump delivered ${h.deliveredBolusUnits()} U but history says ${recorded} U`);
    },
  },
  {
    name: 'marks automatic boluses as SMB',
    async run(h) {
      await h.driver.connect();
      const r = await h.driver.bolus(0.2, { automatic: true });
      assert(r.ok, 'auto bolus failed');
      await settle(h);
      assert((await h.driver.history(0)).some((d) => d.kind === 'smb'), 'automatic bolus not recorded as smb');
    },
  },
  {
    name: 'never over-reports insulin when the link drops mid-bolus',
    async run(h) {
      await h.driver.connect();
      h.dropConnectionAfterNextCommand();
      const r = await h.driver.bolus(1, { automatic: false }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
      await h.advance(60_000);
      await h.driver.connect().catch(() => {});
      await settle(h).catch(() => {});
      const recorded = bolusSum(await h.driver.history(0).catch(() => []));
      assert(recorded <= h.deliveredBolusUnits() + 0.001, `history ${recorded} U exceeds delivered ${h.deliveredBolusUnits()} U`);
      if (r.ok) assert(h.deliveredBolusUnits() > 0, 'reported ok but nothing was delivered');
    },
  },
  {
    name: 'suspends and resumes',
    async run(h) {
      await h.driver.connect();
      assert((await h.driver.suspend()).ok, 'suspend failed');
      assert((await h.driver.status()).suspended, 'not suspended');
      assert((await h.driver.resume()).ok, 'resume failed');
      assert(!(await h.driver.status()).suspended, 'still suspended');
    },
  },
];
