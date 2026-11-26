import { describe, expect, it } from 'vitest';
import { base64Decode, base64Encode, hexDecode, utf8Decode, utf8Encode } from '../src/insight/bytes';
import { CommandQueue } from '../src/insight/command-queue';
import { decodeCredentials, encodeCredentials } from '../src/insight/credentials';
import * as L from '../src/insight/ledger';
import {
  BridgeError,
  parseHistoryPage,
  parseRequestOutcome,
  parseStatus,
  parseBridgeEvent,
  pumpUtcOffsetSeconds,
  sanitizeStatus,
  formatBridgeDate,
} from '../src/insight/models';
import { emptyPersisted, parsePersisted, type PendingCommand } from '../src/insight/state';
import { decidePending, outcomeVerdict } from '../src/insight/uncertainty';

const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);

const statusJson = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-11-25T09:00:00Z',
  pumpLink: 'connected',
  serial: 'S1',
  firmware: '3.1',
  operatingMode: 'started',
  battery: { percent: 80 },
  reservoir: { units: 123.45, cartridgeType: 'prefilled' },
  basal: { activeProfile: 1, rate: 0.85 },
  tbr: null,
  boluses: [],
  pumpTime: { utc: '2026-11-25T09:00:00Z', pumpLocal: '2026-11-25T10:00:00', driftSeconds: 3 },
  limits: { maxBolus: 10, maxBasal: 2.5, bolusStep: 0.05, basalStep: 0.01, minBasal: 0.02 },
  activeAlert: null,
  lastHistorySequence: 9876,
  ...over,
});

describe('Insight bytes', () => {
  it('round-trips base64, utf8 and hex, and rejects garbage', () => {
    const b = Uint8Array.from({ length: 50 }, (_, i) => i * 5);
    expect(base64Decode(base64Encode(b))).toEqual(b);
    expect(base64Decode('a$b=')).toBeNull();
    expect(utf8Decode(utf8Encode('Brücke → 💉'))).toBe('Brücke → 💉');
    expect(utf8Decode(Uint8Array.of(0xff, 0x41))).toBe('�A');
    expect(hexDecode('0aFF')).toEqual(Uint8Array.of(10, 255));
    expect(hexDecode('0')).toBeNull();
    expect(hexDecode('zz')).toBeNull();
  });
});

describe('Insight models', () => {
  it('parses a full status and leaves unknown values null', () => {
    const s = parseStatus(statusJson())!;
    expect(s).toMatchObject({ pumpLink: 'connected', serial: 'S1', operatingMode: 'started', batteryPercent: 80, reservoirUnits: 123.45, basalRate: 0.85, lastHistorySequence: 9876, tbrIsUnreadable: false, bolusesAreUnreadable: false });
    expect(s.timestamp).toBe(Date.UTC(2026, 10, 25, 9, 0, 0));
    expect(s.limits).toMatchObject({ maxBolus: 10, bolusStep: 0.05 });
    const sparse = parseStatus({ pumpLink: 'weird', operatingMode: 'x' })!;
    expect(sparse).toMatchObject({ pumpLink: 'unknown', operatingMode: 'unknown', reservoirUnits: null, tbr: null, boluses: [], timestamp: null });
    expect(parseStatus('nope')).toBeNull();
  });

  it('treats an unreadable temp basal or bolus list as unknown, not as none', () => {
    expect(parseStatus(statusJson({ tbr: { percent: 'x' } }))).toMatchObject({ tbr: null, tbrIsUnreadable: true });
    expect(parseStatus(statusJson({ boluses: [{ bolusId: 1, amount: 1 }] }))).toMatchObject({ boluses: [], bolusesAreUnreadable: true });
    expect(parseStatus(statusJson({ boluses: 'x' }))).toMatchObject({ bolusesAreUnreadable: true });
    expect(parseStatus(statusJson({ tbr: { percent: 120, duration: 60, remaining: 42, start: '2026-11-25T08:18:00Z' } }))?.tbr).toMatchObject({ percent: 120, duration: 60, remaining: 42 });
    expect(parseStatus(statusJson({ boluses: [{ bolusId: 12, type: 'standard', amount: 2, remaining: 0.6 }] }))?.boluses).toEqual([{ bolusId: 12, type: 'standard', amount: 2, remaining: 0.6 }]);
  });

  it('drops the timestamp of a status from the future', () => {
    const s = parseStatus(statusJson({ timestamp: '2026-11-25T09:30:00Z' }))!;
    expect(sanitizeStatus(s, T0).timestamp).toBeNull();
    expect(sanitizeStatus(s, T0 + 30 * 60_000).timestamp).not.toBeNull();
  });

  it('derives the pump UTC offset rounded to 15 minutes', () => {
    expect(pumpUtcOffsetSeconds(parseStatus(statusJson())!.pumpTime)).toBe(3600);
    expect(pumpUtcOffsetSeconds({ utc: T0, pumpLocal: '2026-11-25T14:30:07', driftSeconds: 0 })).toBe(19800 + 0);
    expect(pumpUtcOffsetSeconds({ utc: T0, pumpLocal: 'garbage', driftSeconds: 0 })).toBeNull();
    expect(pumpUtcOffsetSeconds(null)).toBeNull();
  });

  it('keeps unreadable history events instead of failing the page', () => {
    const page = parseHistoryPage({
      events: [
        { seq: 1, time: '2026-11-25T09:00:00Z', type: 'bolusDelivered', data: { programmed: 1, delivered: 1 } },
        { seq: 2, time: '2026-11-25T09:00:00Z', type: 'bolusDelivered', data: { programmed: 2, delivered: 'x' } },
        { seq: 'x', type: 'bolusDelivered' },
        { seq: 4, time: '2026-11-25T09:01:00Z', type: 'somethingNew' },
      ],
      lastSequence: 4,
      more: true,
    })!;
    expect(page.events.map((e) => [e.seq, e.kind])).toEqual([
      [1, 'bolusDelivered'],
      [2, 'bolusDelivered'],
      [4, 'other'],
    ]);
    expect(page.unreadable).toHaveLength(1);
    expect(page.more).toBe(true);
    expect(parseHistoryPage({ events: 'x', lastSequence: 1 })).toBeNull();
  });

  it('parses request outcomes and events', () => {
    expect(parseRequestOutcome({ state: 'succeeded', result: { bolusId: 4 }, completedAt: '2026-11-25T09:00:00Z' })).toMatchObject({ state: 'succeeded', completedAt: T0 });
    expect(parseRequestOutcome({ state: 'strange' }).state).toBe('unknown');
    expect(parseRequestOutcome(null).state).toBe('unknown');
    expect(parseBridgeEvent('bolusProgress', { bolusId: 1, delivered: 0.5, remaining: 0.5 })).toMatchObject({ kind: 'bolusProgress' });
    expect(parseBridgeEvent('bolusProgress', { bolusId: 1 })).toBeNull();
    expect(parseBridgeEvent('pumpLink', { state: 'connected' })).toEqual({ kind: 'pumpLink', state: 'connected' });
    expect(parseBridgeEvent('future', {})).toEqual({ kind: 'unknown', name: 'future' });
    expect(formatBridgeDate(Date.UTC(2026, 10, 25, 9, 0, 0, 123))).toBe('2026-11-25T09:00:00Z');
  });

  it('classifies bridge errors by whether the outcome is unknown', () => {
    expect(new BridgeError('timeout').isUncertainOutcome).toBe(true);
    expect(new BridgeError('linkLost').isUncertainOutcome).toBe(true);
    expect(new BridgeError('notConnected').isUncertainOutcome).toBe(false);
    expect(new BridgeError('encoding').isUncertainOutcome).toBe(false);
    expect(BridgeError.remote('internal', 'x', true).isUncertainOutcome).toBe(true);
    expect(BridgeError.remote('pumpSuspended').isUncertainOutcome).toBe(false);
  });
});

describe('Insight uncertain command resolution', () => {
  const cmd = (over: Partial<PendingCommand> = {}): PendingCommand => ({ kind: 'bolus', requestId: 'r1', sentAt: T0, baselineSequence: 10, units: 1, automatic: false, isUncertain: true, ...over });
  const status = (over: Record<string, unknown> = {}) => parseStatus(statusJson({ timestamp: formatBridgeDate(T0 + 120_000), ...over }))!;
  const event = (seq: number, type: string, data: Record<string, unknown>, at = T0 + 30_000) => parseHistoryPage({ events: [{ seq, time: formatBridgeDate(at), type, data }], lastSequence: seq, more: false })!.events[0]!;
  const NOW = T0 + 130_000;

  it('maps the bridge verdicts', () => {
    expect(outcomeVerdict(parseRequestOutcome({ state: 'succeeded' }))).toBe('delivered');
    expect(outcomeVerdict(parseRequestOutcome({ state: 'failed', error: { code: 'pumpSuspended' } }))).toBe('notDelivered');
    expect(outcomeVerdict(parseRequestOutcome({ state: 'failed', error: { code: 'internal', uncertain: true } }))).toBe('evidence');
    expect(outcomeVerdict(parseRequestOutcome({ state: 'inProgress' }))).toBe('inProgress');
    expect(outcomeVerdict(parseRequestOutcome({ state: 'uncertain' }))).toBe('evidence');
    expect(outcomeVerdict(parseRequestOutcome({ state: 'unknown' }))).toBe('evidence');
  });

  it('decides a bolus only from positive evidence', () => {
    expect(decidePending(cmd(), status(), [event(11, 'bolusDelivered', { programmed: 1, delivered: 1 })], true, NOW)).toBe('delivered');
    expect(decidePending(cmd(), status({ boluses: [{ bolusId: 1, amount: 1, remaining: 0.5 }] }), [], true, NOW)).toBe('delivered');
    expect(decidePending(cmd(), status(), [], true, NOW)).toBe('notDelivered');
    // history incomplete / pump not connected / read too early / unreadable: never "not delivered"
    expect(decidePending(cmd(), status(), [], false, NOW)).toBe('undecided');
    expect(decidePending(cmd(), status({ pumpLink: 'disconnected' }), [], true, NOW)).toBe('undecided');
    expect(decidePending(cmd(), status({ timestamp: formatBridgeDate(T0 + 30_000) }), [], true, NOW)).toBe('undecided');
    expect(decidePending(cmd(), status({ boluses: 'x' }), [], true, NOW)).toBe('undecided');
    // an event at or before the baseline belongs to something else
    expect(decidePending(cmd(), status(), [event(10, 'bolusDelivered', { programmed: 1, delivered: 1 })], true, NOW)).toBe('notDelivered');
    // a status stamped in the future proves nothing
    expect(decidePending(cmd(), status({ timestamp: formatBridgeDate(NOW + 10 * 60_000) }), [], true, NOW)).toBe('undecided');
  });

  it('decides temp basal, cancel and mode commands', () => {
    const tbr = cmd({ kind: 'setTBR', percent: 150, durationMin: 30 });
    expect(decidePending(tbr, status({ tbr: { percent: 150, duration: 30, remaining: 28 } }), [], true, NOW)).toBe('delivered');
    expect(decidePending(tbr, status(), [event(11, 'tbrStart', { percent: 150, duration: 30 })], true, NOW)).toBe('delivered');
    expect(decidePending(tbr, status(), [], true, NOW)).toBe('notDelivered');
    expect(decidePending(tbr, status({ tbr: { percent: 'x' } }), [], true, NOW)).toBe('undecided');
    const cancel = cmd({ kind: 'cancelTBR' });
    expect(decidePending(cancel, status(), [], true, NOW)).toBe('delivered');
    expect(decidePending(cancel, status({ tbr: { percent: 150, duration: 30, remaining: 20 } }), [], true, NOW)).toBe('notDelivered');
    expect(decidePending(cmd({ kind: 'suspend' }), status({ operatingMode: 'stopped' }), [], true, NOW)).toBe('delivered');
    expect(decidePending(cmd({ kind: 'suspend' }), status({ operatingMode: 'started' }), [], true, NOW)).toBe('notDelivered');
    expect(decidePending(cmd({ kind: 'resume' }), status({ operatingMode: 'started' }), [], true, NOW)).toBe('delivered');
    expect(decidePending(cmd({ kind: 'resume' }), status({ operatingMode: 'unknown' }), [], true, NOW)).toBe('undecided');
  });
});

describe('Insight storage', () => {
  it('validates stored state, always treats a stored command as uncertain and drops garbage', () => {
    expect(parsePersisted(null)).toEqual(emptyPersisted());
    expect(parsePersisted('not json')).toEqual(emptyPersisted());
    expect(parsePersisted('{"version":2}')).toEqual(emptyPersisted());
    const p = parsePersisted(
      JSON.stringify({
        version: 1,
        peripheralId: 'abc',
        pending: { kind: 'bolus', requestId: 'r', sentAt: 5, baselineSequence: 3, units: 1, automatic: true, isUncertain: false },
        bolus: { requestId: 'r', units: 1, sentAt: 1, acceptedAt: 2, delivered: 5 },
        doses: [{ kind: 'bolus', id: 'a', date: 1, units: 1 }, { kind: 'bolus', id: 'b', date: 1, units: -1 }, { kind: 'zzz' }, 7, { kind: 'tempBasal', id: 't', date: 1, rate: 1, durationMin: 5 }],
      }),
    );
    expect(p.pending).toMatchObject({ kind: 'bolus', isUncertain: true, automatic: true });
    expect(p.bolus?.delivered).toBe(1); // bounded by the programmed amount
    expect(p.doses.map((d) => d.id)).toEqual(['a', 't']);
    expect(parsePersisted(JSON.stringify({ version: 1, pending: { kind: 'explode', requestId: 'r', sentAt: 1 } })).pending).toMatchObject({ unreadable: true, isUncertain: true }); // never dropped: it keeps blocking insulin
  });

  it('validates credentials and round-trips them', () => {
    const ltk = Uint8Array.from({ length: 32 }, (_, i) => i);
    const text = encodeCredentials({ bridgeId: 'ab12', ltk, clientId: 'cd34' });
    expect(decodeCredentials(text)).toEqual({ bridgeId: 'ab12', ltk, clientId: 'cd34' });
    expect(decodeCredentials('{"bridgeId":"a","ltk":"00","clientId":"b"}')).toBeNull();
    expect(decodeCredentials('x')).toBeNull();
    expect(decodeCredentials('')).toBeNull();
    expect(decodeCredentials(null)).toBeNull();
  });
});

describe('Insight ledger', () => {
  const base = () => emptyPersisted();
  const tracked = (over = {}) => ({ requestId: 'r1', units: 2, bolusId: 7, sentAt: T0, acceptedAt: T0 + 1000, automatic: false, delivered: 0, missCount: 0, stopped: false, ...over });

  it('shows a running bolus with what was delivered, never more than programmed, and finishes it under the same id', () => {
    let s = L.trackBolus(base(), tracked());
    expect(L.historyOf(s, 0, T0)).toEqual([]);
    s = L.bolusProgress(s, 0.5);
    s = L.bolusProgress(s, 0.2); // never backwards
    expect(L.historyOf(s, 0, T0)[0]).toMatchObject({ kind: 'bolus', units: 0.5, id: L.bolusDoseId('r1') });
    s = L.bolusProgress(s, 5); // never above the programmed amount
    expect(L.historyOf(s, 0, T0)[0]).toMatchObject({ units: 2 });
    s = L.finishBolus(s, 1.5, true);
    expect(s.bolus).toBeNull();
    expect(L.historyOf(s, 0, T0)).toMatchObject([{ units: 1.5, id: L.bolusDoseId('r1') }]);
    expect(s.knownBoluses).toEqual([{ bolusId: 7, doseId: L.bolusDoseId('r1'), final: true }]);
  });

  it('marks automatic boluses as SMB, corrects a guessed amount once and removes a bolus that delivered nothing', () => {
    let s = L.finishBolus(L.trackBolus(base(), tracked({ automatic: true, delivered: 0.1 })), 2, false);
    expect(L.historyOf(s, 0, T0)[0]).toMatchObject({ kind: 'smb', units: 2 });
    const known = s.knownBoluses[0]!;
    expect(known.final).toBe(false);
    s = L.correctKnownBolus(s, known, 1.2);
    expect(L.historyOf(s, 0, T0)[0]).toMatchObject({ units: 1.2 });
    expect(s.knownBoluses[0]!.final).toBe(true);
    const none = L.finishBolus(L.trackBolus(base(), tracked({ delivered: 0 })), 0, true);
    expect(L.historyOf(none, 0, T0)).toEqual([]);
  });

  it('truncates a temp basal when it ends early and keeps a replaced one cut at the start of the next', () => {
    const t = { requestId: 'a', percent: 50, startedAt: T0, durationMin: 30, segmentIds: ['a1', 'a2'] };
    let s = L.startTemp(base(), t, [
      { date: T0, rate: 0.5, durationMin: 10 },
      { date: T0 + 10 * 60_000, rate: 1, durationMin: 20 },
    ]);
    expect(L.activeTemp(s, T0 + 60_000)).not.toBeNull();
    expect(L.activeTemp(s, T0 + 31 * 60_000)).toBeNull();
    s = L.endTemp(s, T0 + 4 * 60_000);
    expect(L.historyOf(s, 0, T0).map((d) => d.kind === 'tempBasal' && [d.date - T0, d.durationMin])).toEqual([
      [0, 4],
      [4 * 60_000, 0],
    ]);
    expect(s.temp).toBeNull();
    const again = L.startTemp(L.startTemp(base(), t, [{ date: T0, rate: 0.5, durationMin: 30 }]), { ...t, requestId: 'b', startedAt: T0 + 10 * 60_000, segmentIds: ['b'] }, [{ date: T0 + 10 * 60_000, rate: 1.5, durationMin: 30 }]);
    expect(L.historyOf(again, 0, T0).find((d) => d.id === 'a1')).toMatchObject({ durationMin: 10 });
  });

  it('suspends open-ended and closes the suspend on resume', () => {
    let s = L.suspend(base(), T0, 'sus');
    expect(L.suspend(s, T0 + 1, 'again')).toBe(s);
    expect(L.historyOf(s, 0, T0 + 5 * 60_000)).toMatchObject([{ kind: 'suspend', durationMin: 5 }]);
    s = L.resume(s, T0 + 8 * 60_000);
    expect(L.historyOf(s, 0, T0 + 60 * 60_000)).toMatchObject([{ kind: 'suspend', durationMin: 8 }]);
    expect(L.resume(s, T0)).toBe(s);
  });

  it('prunes old doses but never one that is still referenced', () => {
    const old = T0 - 48 * 3_600_000;
    const s = { ...base(), doses: [{ kind: 'bolus' as const, id: 'old', date: old, units: 1 }, { kind: 'bolus' as const, id: L.bolusDoseId('r1'), date: old, units: 1 }], bolus: tracked() };
    expect(L.prune(s, T0).doses.map((d) => d.id)).toEqual([L.bolusDoseId('r1')]);
  });
});

describe('Insight command queue', () => {
  it('runs one command at a time and lets safety commands overtake waiting ones, not the running one', async () => {
    const q = new CommandQueue();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${name}`);
      return name;
    };
    const a = q.enqueue(task('a', 20));
    const b = q.enqueue(task('b', 1));
    const c = q.enqueue(task('safety', 1), true);
    const d = q.enqueue(task('d', 1));
    expect(q.hasSafetyWaiting).toBe(true);
    expect(await Promise.all([a, b, c, d])).toEqual(['a', 'b', 'safety', 'd']);
    expect(order.filter((o) => o.startsWith('start')).map((o) => o.slice(6))).toEqual(['a', 'safety', 'b', 'd']);
  });

  it('keeps going after a failing command', async () => {
    const q = new CommandQueue();
    const bad = q.enqueue(async () => {
      throw new Error('x');
    });
    await expect(bad).rejects.toThrow('x');
    await expect(q.enqueue(async () => 5)).resolves.toBe(5);
  });
});
