/**
 * Port of MedtrumKitTests/PumpManager/BaseResetDetectionTests.swift (loopandlearn/MedtrumKit,
 * MIT License, (c) the original MedtrumKit authors) plus link-layer tests of the TypeScript port.
 */
import { describe, expect, it } from 'vitest';
import type { BleConnection, Bytes } from '@buddy/core';
import { silentLogger } from '@buddy/core';
import { DoseLedger } from '../src/medtrum/dose-ledger';
import { CommandType, PatchState, type PatchState as PatchStateT } from '../src/medtrum/enums';
import { MEDTRUM_WRITE_UUID, MedtrumLink, isUncertain } from '../src/medtrum/link';
import { emptySyncResponse, type SynchronizePacketResponse } from '../src/medtrum/notification-packet';
import { GetTimePacket, CancelTempBasalPacket } from '../src/medtrum/packets';
import { parseSession, initialSession } from '../src/medtrum/session';
import { frameResponse } from '../src/medtrum/simulator';
import { baseResetCheck, deliveryStoppedAt, modelFromSerial, type ResetCheckState } from '../src/medtrum/state-syncer';
import { fromHex } from '@buddy/core';

const isSetup = (s: PatchStateT) => [0, 1, 2, 3, 4, 5, 6].includes(s);
const makeState = (pumpState: PatchStateT, patchId: number | null = 256): ResetCheckState & { patchSessionEnded: boolean } => ({
  pumpState,
  // An activated patch's session runs
  patchSessionEnded: isSetup(pumpState),
  patchId,
  lastSync: 0,
});
const makeResponse = (state: PatchStateT, patchId?: number, patchAge?: number): SynchronizePacketResponse =>
  emptySyncResponse(state, {
    ...(patchId !== undefined ? { storage: { sequence: 0, patchId } } : {}),
    ...(patchAge !== undefined ? { patchAge } : {}),
  });

describe('Medtrum BaseResetDetectionTests', () => {
  it('testActivePatchStayingActiveIsNotAReset', () => {
    expect(baseResetCheck(makeResponse(PatchState.active, 256), makeState(PatchState.active))).toBe('noReset');
  });

  it('testActivePatchGettingSuspendedOrFaultedIsNotAReset', () => {
    for (const s of [PatchState.suspended, PatchState.hourlyMaxSuspended, PatchState.occlusion, PatchState.stopped]) {
      expect(baseResetCheck(makeResponse(s), makeState(PatchState.active))).toBe('noReset');
    }
  });

  it('testSetupOfANewPatchIsNotAReset', () => {
    for (const s of [PatchState.none, PatchState.idle, PatchState.filled, PatchState.priming, PatchState.primed]) {
      expect(baseResetCheck(makeResponse(s, 257), makeState(PatchState.none, 0))).toBe('noReset');
    }
  });

  // After a deactivation the old patch, stopped, is reported until the new one is set up
  it('testSetupOfANewPatchAfterTheOldOneStoppedIsNotAReset', () => {
    const ended = { ...makeState(PatchState.stopped, 0), patchSessionEnded: true };
    for (const s of [PatchState.none, PatchState.idle, PatchState.filled, PatchState.priming, PatchState.primed]) {
      expect(baseResetCheck(makeResponse(s, 257), ended)).toBe('noReset');
    }
  });

  // The first thing the rebooted base said on 2026-09-19: state none, next patch id, age of 1s
  it('testNoneWithNewPatchIdIsAReset', () => {
    expect(baseResetCheck(makeResponse(PatchState.none, 257, 1), makeState(PatchState.active))).toBe('reset');
  });

  it('testActivatedPatchGoingBackToSetupIsAReset', () => {
    for (const old of [PatchState.active, PatchState.suspended, PatchState.lowBgSuspended, PatchState.occlusion]) {
      for (const s of [PatchState.idle, PatchState.filled, PatchState.priming, PatchState.primed]) {
        expect(baseResetCheck(makeResponse(s), makeState(old))).toBe('reset');
      }
    }
  });

  // `.none` is also what an unknown state byte parses to
  it('testNoneWithoutANewPatchIdIsUnconfirmed', () => {
    const active = makeState(PatchState.active);
    expect(baseResetCheck(makeResponse(PatchState.none), active)).toBe('unconfirmed');
    expect(baseResetCheck(makeResponse(PatchState.none, 256), active)).toBe('unconfirmed');
  });

  it('testDeliveryStoppedWhenTheBaseBooted', () => {
    const now = Date.now();
    const state = { ...makeState(PatchState.active), lastSync: now - 3 * 3600_000 };
    expect(deliveryStoppedAt(makeResponse(PatchState.idle, 257, 3600), state, now)).toBe(now - 3600_000);
  });

  it('testDeliveryDidNotStopBeforeTheLastSync', () => {
    const now = Date.now();
    const state = { ...makeState(PatchState.active), lastSync: now - 60_000 };
    expect(deliveryStoppedAt(makeResponse(PatchState.idle, 257, 3600), state, now)).toBe(state.lastSync);
  });

  it('testDeliveryStoppedNowWithoutAPatchAge', () => {
    const now = Date.now();
    expect(deliveryStoppedAt(makeResponse(PatchState.idle), makeState(PatchState.active), now)).toBe(now);
  });
});

describe('Medtrum model from serial', () => {
  it('decodes the model like MedtrumPumpState.model', () => {
    expect(modelFromSerial(fromHex('AA76F9D9'))).toBe('MD0201');
    expect(modelFromSerial(fromHex('00000000'))).toBe('INVALID');
  });
});

/** Minimal scripted BLE connection for link-layer tests. */
function scriptedConnection(respond: (data: Bytes, notify: (d: Bytes) => void) => void) {
  const subs = new Map<string, (d: Bytes) => void>();
  const dc = new Set<(e: Error | null) => void>();
  const conn: BleConnection = {
    deviceId: 'x',
    mtu: 185,
    read: async () => new Uint8Array(0),
    write: async (_s, c, data) => {
      respond(data, (d) => setTimeout(() => subs.get(MEDTRUM_WRITE_UUID)?.(d), 0));
    },
    subscribe: async (_s, c, cb) => {
      subs.set(c, cb);
      return () => subs.delete(c);
    },
    onDisconnect: (l) => {
      dc.add(l);
      return () => dc.delete(l);
    },
    disconnect: async () => dc.forEach((l) => l(null)),
  };
  return conn;
}

describe('Medtrum link layer', () => {
  const opts = { writeTimeoutMs: 100, log: silentLogger, onStatus: () => {}, onDisconnect: () => {} };

  it('skips a "busy" (16384) answer and waits for the real response', async () => {
    const conn = scriptedConnection((req, notify) => {
      const seq = req[2]!;
      notify(frameResponse(CommandType.GET_TIME, seq, new Uint8Array([0x00, 0x40]))[0]!);
      notify(frameResponse(CommandType.GET_TIME, seq, new Uint8Array([0, 0, 224, 238, 88, 17]))[0]!);
    });
    const link = new MedtrumLink(conn, opts);
    await link.start();
    const r = await link.writePacket(new GetTimePacket());
    expect(r).toEqual({ ok: true, data: { time: 1_679_575_392_000 } });
  });

  it('ignores responses for another sequence number and times out', async () => {
    const conn = scriptedConnection((req, notify) => {
      notify(frameResponse(CommandType.GET_TIME, (req[2]! + 1) & 0xff, new Uint8Array([0, 0, 224, 238, 88, 17]))[0]!);
    });
    const link = new MedtrumLink(conn, opts);
    await link.start();
    const r = await link.writePacket(new GetTimePacket());
    expect(r).toEqual({ ok: false, error: { kind: 'timeout' } });
    expect(!r.ok && isUncertain(r.error)).toBe(true);
  });

  it('reports a corrupted answer as invalid data (outcome uncertain), a clean non-zero code as rejection', async () => {
    let mode: 'corrupt' | 'reject' = 'corrupt';
    const conn = scriptedConnection((req, notify) => {
      const frag = frameResponse(CommandType.CANCEL_TEMP_BASAL, req[2]!, new Uint8Array([8, 0]))[0]!;
      if (mode === 'corrupt') frag[frag.length - 1] = frag[frag.length - 1]! ^ 0xff;
      notify(frag);
    });
    const link = new MedtrumLink(conn, opts);
    await link.start();
    const a = await link.writePacket(new CancelTempBasalPacket());
    expect(!a.ok && a.error.kind).toBe('invalidData');
    expect(!a.ok && isUncertain(a.error)).toBe(true);
    mode = 'reject';
    const b = await link.writePacket(new CancelTempBasalPacket());
    expect(b).toEqual({ ok: false, error: { kind: 'invalidResponse', code: 8 } });
    expect(!b.ok && isUncertain(b.error)).toBe(false);
  });

  it('wraps the write sequence at 254 like MedtrumKit', async () => {
    const seqs: number[] = [];
    const conn = scriptedConnection((req, notify) => {
      seqs.push(req[2]!);
      notify(frameResponse(CommandType.GET_TIME, req[2]!, new Uint8Array([0, 0, 224, 238, 88, 17]))[0]!);
    });
    const link = new MedtrumLink(conn, opts);
    await link.start();
    for (let i = 0; i < 256; i++) await link.writePacket(new GetTimePacket());
    expect(seqs.slice(252, 256)).toEqual([252, 253, 0, 1]);
  });

  it('fails a command in flight immediately when the link drops', async () => {
    const conn = scriptedConnection(() => {});
    const link = new MedtrumLink(conn, { ...opts, writeTimeoutMs: 10_000 });
    await link.start();
    const pending = link.writePacket(new GetTimePacket());
    await new Promise((r) => setTimeout(r, 5));
    await conn.disconnect();
    expect(await pending).toEqual({ ok: false, error: { kind: 'disconnected' } });
  });
});

describe('Medtrum dose ledger', () => {
  it('never reports more than the pump said was delivered', () => {
    const l = new DoseLedger();
    l.bolusSent(1, false, 1000);
    expect(l.history(0, 2000)).toEqual([]);
    l.bolusConfirmed();
    expect(l.bolusProgress(0.3, false)).toBe(true);
    expect(l.history(0, 3000)).toMatchObject([{ kind: 'bolus', units: 0.3 }]);
    expect(l.bolusProgress(1.2, true)).toBe(false); // impossible report ignored
    expect(l.finalizeBolus()).toMatchObject({ units: 0.3 });
    expect(l.pendingBolus).toBeNull();
  });

  it('truncates temp basals and closes suspends', () => {
    const l = new DoseLedger();
    l.startTempBasal(2, 30, 0);
    l.suspend(10 * 60_000);
    l.resume(25 * 60_000);
    const h = l.history(0, 30 * 60_000);
    expect(h).toMatchObject([
      { kind: 'tempBasal', rate: 2, durationMin: 10 },
      { kind: 'suspend', durationMin: 15 },
    ]);
  });
});

describe('Medtrum session storage', () => {
  it('round-trips and rejects unknown formats', () => {
    const s = { ...initialSession(), sessionToken: '9b020000', patchId: 41, pumpState: PatchState.active, patchSessionEnded: false };
    expect(parseSession(JSON.stringify(s))).toEqual(s);
    expect(() => parseSession('{"version":2}')).toThrow();
    expect(parseSession(JSON.stringify({ ...s, sessionToken: 'nothex!!' })).sessionToken).toBe('');
  });
});
