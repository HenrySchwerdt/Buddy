import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, DEFAULT_PROFILE, type ActiveOverride, type ActiveTempTarget, type CarbEntry, type DataSnapshot, type InsulinDose, type OverridePreset } from '@buddy/core';
import { executeCommand, validateEditMealInput, validateMealAge, type RemoteDeps } from '../../remote-control/commands';
import { handleEncryptedCommand, type HandlerContext } from '../../remote-control/handler';
import { parseCommandPayload, PayloadError } from '../../remote-control/payload';
import { base64ToBytes, bytesToBase64, decryptCommand, DecryptionError, encryptCommand } from '../../remote-control/secure-message';

const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;
const MIN = 60_000;
const SECRET = 'correct-horse-battery-staple';
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i + 1);

const wire = (o: Record<string, unknown>) => ({ user: 'pat', timestamp: SEC, ...o });
const seal = (o: Record<string, unknown>, secret = SECRET) => encryptCommand(wire(o), secret, NONCE);

interface Calls {
  bolus: number[];
  meals: Array<{ carbs: number; fat: number; protein: number; date: number; note: string }>;
  deleted: string[];
  tempTargets: ActiveTempTarget[];
  overrides: ActiveOverride[];
  cancelledTT: number;
  cancelledOverride: number;
}

function makeDeps(opts: { carbs?: CarbEntry[]; doses?: InsulinDose[]; presets?: OverridePreset[] } = {}) {
  const calls: Calls = { bolus: [], meals: [], deleted: [], tempTargets: [], overrides: [], cancelledTT: 0, cancelledOverride: 0 };
  const snapshot: DataSnapshot = { glucose: [], doses: opts.doses ?? [], carbs: opts.carbs ?? [], loopRuns: [] };
  const deps: RemoteDeps = {
    now: () => NOW,
    limits: () => ({ ...DEFAULT_LIMITS, maxBolus: 10, maxIOB: 8 }),
    mealLimits: () => ({ maxCarbs: 250, maxFat: 250, maxProtein: 250 }),
    profile: () => DEFAULT_PROFILE,
    snapshot: () => snapshot,
    overridePresets: () => opts.presets ?? [],
    tempTarget: () => null,
    override: () => null,
    deliverBolus: async (u) => {
      calls.bolus.push(u);
      return u;
    },
    addMeal: (m) => {
      calls.meals.push(m);
      return `carbs-new-${calls.meals.length}`;
    },
    deleteMeal: async (id) => {
      calls.deleted.push(id);
    },
    startTempTarget: (t) => calls.tempTargets.push(t),
    cancelTempTarget: () => void calls.cancelledTT++,
    startOverride: (o) => calls.overrides.push(o),
    cancelOverride: () => void calls.cancelledOverride++,
    recalculate: async () => {},
  };
  return { deps, calls };
}

const run = (o: Record<string, unknown>, deps: RemoteDeps) => executeCommand(parseCommandPayload(wire(o)), deps);

describe('secure message', () => {
  it('decrypts what node crypto sealed with the same scheme (key = sha256(secret), nonce || ct || tag)', () => {
    const key = createHash('sha256').update(SECRET, 'utf8').digest();
    const c = createCipheriv('aes-256-gcm', key, Buffer.from(NONCE));
    const ct = Buffer.concat([c.update(JSON.stringify(wire({ command_type: 'bolus', bolus_amount: 1.5 })), 'utf8'), c.final()]);
    const message = Buffer.concat([Buffer.from(NONCE), ct, c.getAuthTag()]).toString('base64');
    expect(decryptCommand(message, SECRET)).toMatchObject({ commandType: 'bolus', bolusAmount: 1.5, user: 'pat', timestamp: SEC });
  });

  it('round-trips through encryptCommand', () => {
    expect(decryptCommand(seal({ command_type: 'cancel_override' }), SECRET).commandType).toBe('cancel_override');
  });

  it('rejects a wrong secret, tampering, short and non-base64 input without echoing the secret', () => {
    const msg = seal({ command_type: 'bolus', bolus_amount: 1 });
    expect(() => decryptCommand(msg, 'other')).toThrow(DecryptionError);
    const bytes = base64ToBytes(msg);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    expect(() => decryptCommand(bytesToBase64(bytes), SECRET)).toThrow(/Decryption failed/);
    expect(() => decryptCommand(bytesToBase64(new Uint8Array(12)), SECRET)).toThrow(/too short/);
    expect(() => decryptCommand('***', SECRET)).toThrow(/Base64/);
    expect(() => decryptCommand(msg, '')).toThrow(/empty/);
    try {
      decryptCommand(msg, 'topsecret');
    } catch (e) {
      expect(String(e)).not.toContain('topsecret');
    }
  });

  it('base64 helpers agree with Buffer', () => {
    const b = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
    expect([...base64ToBytes(Buffer.from(b).toString('base64'))]).toEqual([...b]);
  });
});

describe('parseCommandPayload', () => {
  it('maps wire names and unknown types', () => {
    const p = parseCommandPayload({ user: 'a', timestamp: 5, command_type: 'edit_meal', meal_id: 'm1', scheduled_time: 9, carbs: 30, fat: 1, protein: 2, command_id: 'c' });
    expect(p).toMatchObject({ commandType: 'edit_meal', mealId: 'm1', scheduledTime: 9, carbs: 30, commandId: 'c' });
    expect(parseCommandPayload({ user: 'a', timestamp: 5, command_type: 'reboot' }).commandType).toBe('unknown');
  });
  it('rejects malformed payloads', () => {
    expect(() => parseCommandPayload({ user: 'a' })).toThrow(PayloadError);
    expect(() => parseCommandPayload({ user: 'a', timestamp: 5, command_type: 'bolus', bolus_amount: 'lots' })).toThrow(PayloadError);
    expect(() => parseCommandPayload({ user: 'a', timestamp: 5, command_type: 'meal', carbs: 1.5 })).toThrow(PayloadError);
  });
});

describe('bolus command', () => {
  it('delivers a valid bolus', async () => {
    const { deps, calls } = makeDeps();
    expect(await run({ command_type: 'bolus', bolus_amount: 2 }, deps)).toMatchObject({ ok: true });
    expect(calls.bolus).toEqual([2]);
  });

  it('never delivers above max bolus, above max IOB, or after a recent bolus since the command was sent', async () => {
    const a = makeDeps();
    expect((await run({ command_type: 'bolus', bolus_amount: 11 }, a.deps)).message).toMatch(/exceeds the maximum allowed/);
    const b = makeDeps({ doses: [{ kind: 'bolus', id: 'x', date: NOW - 30 * MIN, units: 7 }] });
    expect((await run({ command_type: 'bolus', bolus_amount: 3 }, b.deps)).message).toMatch(/max IOB/);
    const c = makeDeps({ doses: [{ kind: 'smb', id: 'y', date: NOW - 2 * MIN, units: 0.5 }] });
    const sentEarlier = { command_type: 'bolus', bolus_amount: 2, timestamp: SEC - 5 * 60 };
    expect((await run(sentEarlier, c.deps)).message).toMatch(/since the command was sent/);
    for (const x of [a, b, c]) expect(x.calls.bolus).toEqual([]);
  });

  it('rejects a missing amount', async () => {
    const { deps, calls } = makeDeps();
    expect(await run({ command_type: 'bolus' }, deps)).toMatchObject({ ok: false });
    expect(calls.bolus).toEqual([]);
  });

  it('reports a pump failure as rejection', async () => {
    const { deps } = makeDeps();
    const failing = { ...deps, deliverBolus: async () => Promise.reject(new Error('Pump busy')) };
    expect(await run({ command_type: 'bolus', bolus_amount: 1 }, failing)).toEqual({ ok: false, message: 'Pump busy' });
  });
});

describe('meal commands', () => {
  it('logs a meal with the remote note, dated at the scheduled time', async () => {
    const { deps, calls } = makeDeps();
    const r = await run({ command_type: 'meal', carbs: 40, fat: 5, scheduled_time: SEC + 600 }, deps);
    expect(r.ok).toBe(true);
    expect(calls.meals).toEqual([{ carbs: 40, fat: 5, protein: 0, date: NOW + 600_000, note: '📡' }]);
  });

  it('checks maximums and replays', async () => {
    const { deps, calls } = makeDeps({ carbs: [{ id: 'c1', date: NOW - MIN, grams: 10 }] });
    expect((await run({ command_type: 'meal', carbs: 20, timestamp: SEC - 120 }, deps)).message).toMatch(/newer carb entries/);
    const fresh = makeDeps();
    expect((await run({ command_type: 'meal', carbs: 300 }, fresh.deps)).message).toMatch(/exceeds the maximum/);
    expect((await run({ command_type: 'meal' }, fresh.deps)).message).toMatch(/incomplete/);
    expect(calls.meals).toEqual([]);
    expect(fresh.calls.meals).toEqual([]);
  });

  it('a meal with a bolus validates and delivers the bolus too, but a rejected bolus still keeps the meal', async () => {
    const ok = makeDeps();
    await run({ command_type: 'meal', carbs: 30, bolus_amount: 2 }, ok.deps);
    expect(ok.calls.bolus).toEqual([2]);
    const bad = makeDeps();
    const r = await run({ command_type: 'meal', carbs: 30, bolus_amount: 50 }, bad.deps);
    expect(r.ok).toBe(false);
    expect(bad.calls.bolus).toEqual([]);
  });

  it('deletes and edits a meal, rejecting extras, missing, old and equivalent entries', async () => {
    const carbs: CarbEntry[] = [
      { id: 'c1', date: NOW - 30 * MIN, grams: 30, note: 'lunch' },
      { id: 'fpu-1', date: NOW - 20 * MIN, grams: 10 },
      { id: 'old', date: NOW - 30 * 3_600_000, grams: 10 },
    ];
    const { deps, calls } = makeDeps({ carbs });
    expect(await run({ command_type: 'delete_meal', meal_id: 'c1' }, deps)).toMatchObject({ ok: true, ack: { result: 'deleted' } });
    expect(calls.deleted).toEqual(['c1']);
    expect(await run({ command_type: 'delete_meal', meal_id: 'nope' }, deps)).toMatchObject({ ok: false, ack: { result: 'not_found' } });
    expect((await run({ command_type: 'delete_meal', meal_id: 'c1', carbs: 5 }, deps)).message).toMatch(/cannot carry/);
    expect((await run({ command_type: 'delete_meal', meal_id: 'old' }, deps)).message).toMatch(/older than 24 hours/);
    expect((await run({ command_type: 'delete_meal', meal_id: 'fpu-1' }, deps)).message).toMatch(/carb equivalent/);

    const edit = await run({ command_type: 'edit_meal', meal_id: 'c1', carbs: 45, fat: 0, protein: 0, scheduled_time: SEC - 600 }, deps);
    expect(edit).toMatchObject({ ok: true, ack: { result: 'updated', mealId: 'carbs-new-1' } });
    expect(calls.meals.at(-1)).toMatchObject({ carbs: 45, note: 'lunch' });
    expect((await run({ command_type: 'edit_meal', meal_id: 'c1', carbs: 0, fat: 0, protein: 0, scheduled_time: SEC }, deps)).message).toMatch(/all meal amounts are zero/);
    expect((await run({ command_type: 'edit_meal', meal_id: 'c1', carbs: 5 }, deps)).message).toMatch(/requires/);
  });

  it('helper validations', () => {
    expect(validateMealAge(NOW - 25 * 3_600_000, NOW)).toMatch(/older/);
    expect(validateMealAge(NOW + 13 * 3_600_000, NOW)).toMatch(/future/);
    expect(validateMealAge(NOW, NOW)).toBeNull();
    expect(validateEditMealInput(-1, 0, 0, { maxCarbs: 1, maxFat: 1, maxProtein: 1 })).toMatch(/negative/);
  });
});

describe('temp target and override commands', () => {
  it('starts a temp target, rejects out of range, cancels', async () => {
    const { deps, calls } = makeDeps();
    expect((await run({ command_type: 'temp_target', target: 140, duration: 60 }, deps)).ok).toBe(true);
    expect(calls.tempTargets[0]).toMatchObject({ target: 140, durationMin: 60, startedAt: NOW });
    expect((await run({ command_type: 'temp_target', target: 40, duration: 60 }, deps)).ok).toBe(false);
    expect((await run({ command_type: 'temp_target', target: 140 }, deps)).message).toMatch(/incomplete/);
    expect(calls.tempTargets).toHaveLength(1);
    expect((await run({ command_type: 'cancel_temp_target' }, deps)).ok).toBe(true);
    expect(calls.cancelledTT).toBe(1);
  });

  it('starts a preset override by name, rejects unknown names, cancels', async () => {
    const preset: OverridePreset = { id: 'p1', name: 'Exercise', percentage: 70, target: 150, scaleIsf: true, scaleCr: false, disableSmb: false, durationMin: 60 };
    const { deps, calls } = makeDeps({ presets: [preset] });
    expect((await run({ command_type: 'start_override', overrideName: 'Exercise' }, deps)).ok).toBe(true);
    expect(calls.overrides[0]).toMatchObject({ id: 'p1', presetId: 'p1', startedAt: NOW });
    expect((await run({ command_type: 'start_override', overrideName: 'Sleep' }, deps)).ok).toBe(false);
    expect((await run({ command_type: 'start_override' }, deps)).ok).toBe(false);
    expect((await run({ command_type: 'cancel_override' }, deps)).ok).toBe(true);
    expect(calls.overrides).toHaveLength(1);
  });

  it('rejects an unsupported command', async () => {
    const { deps } = makeDeps();
    expect(await run({ command_type: 'reboot' }, deps)).toMatchObject({ ok: false, ack: { result: 'rejected' } });
  });
});

describe('handleEncryptedCommand', () => {
  function ctx(over: Partial<HandlerContext> = {}) {
    const { deps, calls } = makeDeps();
    const reports: string[] = [];
    const remembered: string[] = [];
    const c: HandlerContext = {
      enabled: true,
      secret: SECRET,
      deps,
      executedIds: [],
      rememberCommand: (id) => void remembered.push(id),
      report: async (note) => void reports.push(note),
      ...over,
    };
    return { c, calls, reports, remembered };
  }

  it('executes an authenticated command and audits it', async () => {
    const { c, calls, reports, remembered } = ctx();
    const out = await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 1, command_id: 'c-1' }), c);
    expect(out).toMatchObject({ handled: true, result: { ok: true } });
    expect(calls.bolus).toEqual([1]);
    expect(remembered).toEqual(['c-1']);
    expect(reports[0]).toMatch(/processed successfully/);
  });

  it('does nothing when disabled, without a secret or with the wrong secret', async () => {
    const msg = seal({ command_type: 'bolus', bolus_amount: 1 });
    const a = ctx({ enabled: false });
    expect(await handleEncryptedCommand(msg, a.c)).toEqual({ handled: false, reason: 'disabled' });
    const b = ctx({ secret: '' });
    expect(await handleEncryptedCommand(msg, b.c)).toEqual({ handled: false, reason: 'no-secret' });
    const c2 = ctx({ secret: 'wrong' });
    expect(await handleEncryptedCommand(msg, c2.c)).toEqual({ handled: false, reason: 'decryption' });
    for (const x of [a, b, c2]) expect(x.calls.bolus).toEqual([]);
    expect(JSON.stringify([b.reports, c2.reports])).not.toContain(SECRET);
  });

  it('enforces the 10 minute window in both directions', async () => {
    const old = ctx();
    expect(await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 1, timestamp: SEC - 601 }), old.c)).toEqual({ handled: false, reason: 'too-old' });
    const future = ctx();
    expect(await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 1, timestamp: SEC + 601 }), future.c)).toEqual({ handled: false, reason: 'future' });
    const edge = ctx();
    expect((await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 1, timestamp: SEC - 600 }), edge.c)).handled).toBe(true);
    expect(old.calls.bolus).toEqual([]);
    expect(future.calls.bolus).toEqual([]);
  });

  it('rejects a replayed command id', async () => {
    const { c, calls } = ctx({ executedIds: ['c-1'] });
    expect(await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 1, command_id: 'c-1' }), c)).toEqual({ handled: false, reason: 'replay' });
    expect(calls.bolus).toEqual([]);
  });

  it('rejects a replayed message that carries no command id (scheduled meal)', async () => {
    const executed: string[] = [];
    const { c, calls } = ctx({ executedIds: executed, rememberCommand: (id) => void executed.push(id) });
    const msg = seal({ command_type: 'meal', carbs: 20, scheduled_time: SEC + 3600 });
    expect((await handleEncryptedCommand(msg, c)).handled).toBe(true);
    expect(await handleEncryptedCommand(msg, c)).toEqual({ handled: false, reason: 'replay' });
    expect(calls.meals).toHaveLength(1);
  });

  it('a safety rejection is reported and executes nothing', async () => {
    const { c, calls, reports } = ctx();
    const out = await handleEncryptedCommand(seal({ command_type: 'bolus', bolus_amount: 99 }), c);
    expect(out).toMatchObject({ handled: true, result: { ok: false } });
    expect(calls.bolus).toEqual([]);
    expect(reports[0]).toMatch(/Command rejected/);
    expect(vi.isMockFunction(console.warn)).toBe(false);
  });
});
