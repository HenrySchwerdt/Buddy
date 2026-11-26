// State tests for the port of OmnipodKit (MIT License, (c) LoopKit Authors).
/**
 * Omnipod DASH state handling: dose ledger, resolution of unacknowledged commands, pod
 * advertisements, the persisted record, and the pairing dialogue against the simulator.
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import {
  CancelDeliveryType,
  DeliveryStatus,
  PodProgress,
  type StatusResponseBlock,
} from '../src/omnipod/common';
import {
  endBasalSegment,
  emptyLedger,
  finishBolus,
  ledgerHistory,
  startBolus,
  startTempBasal,
  suspendDelivery,
  resumeDelivery,
  updateBolusFromPod,
} from '../src/omnipod/dash/dose-ledger';
import { resolvePending, type PendingCommand } from '../src/omnipod/dash/pending';
import { advertisementUuids, parseAdvertisement, shortUuid } from '../src/omnipod/dash/scan';
import { initialRecord, parseRecord } from '../src/omnipod/dash/record';
import { GET_POD_STATUS_HEX_COMMAND, negotiateLtk, pairMessage } from '../src/omnipod/dash/ltk-exchanger';
import { DashKeyExchange } from '../src/omnipod/dash/key-exchange';
import { encodeMessagePacket } from '../src/omnipod/dash/message-packet';
import { PodLink } from '../src/omnipod/dash/link';
import { DASH_ADVERTISEMENT_UUID } from '../src/omnipod/dash/constants';
import { OmnipodDashSimulator } from '../src/omnipod';
import { createFakeBle } from '../src/testkit';
import { silentLogger } from '@buddy/core';

const T0 = Date.UTC(2026, 10, 25, 8, 0, 0);
const MIN = 60_000;

describe('dose ledger', () => {
  it('reports a running bolus with what the pod delivered, never moving backwards', () => {
    let l = startBolus(emptyLedger(), { requested: 1, automatic: false, at: T0, delivered: 0 });
    expect(ledgerHistory(l, 0, T0)).toEqual([]); // nothing confirmed yet
    l = updateBolusFromPod(l, 0.3, false);
    expect(ledgerHistory(l, 0, T0 + 1000)[0]).toMatchObject({ kind: 'bolus', units: 0.3 });
    l = updateBolusFromPod(l, 0.2, false); // an older status arriving late
    expect(ledgerHistory(l, 0, T0 + 1000)[0]).toMatchObject({ units: 0.3 });
    l = updateBolusFromPod(l, 5, false); // more than requested is clamped
    expect(ledgerHistory(l, 0, T0)[0]).toMatchObject({ units: 1 });
    l = finishBolus(l, 0.6);
    expect(l.bolus).toBeNull();
    expect(ledgerHistory(l, 0, T0)).toEqual([expect.objectContaining({ kind: 'bolus', units: 0.6, date: T0 })]);
  });

  it('records automatic boluses as SMB and drops boluses that delivered nothing', () => {
    const smb = finishBolus(startBolus(emptyLedger(), { requested: 0.5, automatic: true, at: T0, delivered: 0.5 }), 0.5);
    expect(smb.doses[0]).toMatchObject({ kind: 'smb', units: 0.5 });
    const none = finishBolus(startBolus(emptyLedger(), { requested: 0.5, automatic: false, at: T0, delivered: 0 }), 0);
    expect(none.doses).toEqual([]);
  });

  it('truncates a temp basal that ends early and keeps one that ran its course', () => {
    const l = startTempBasal(emptyLedger(), { rate: 2, durationMin: 60, at: T0 });
    expect(l.basal.kind).toBe('temp');
    const cut = endBasalSegment(l, T0 + 20 * MIN);
    expect(cut.doses[0]).toMatchObject({ kind: 'tempBasal', rate: 2, durationMin: 20 });
    expect(cut.basal.kind).toBe('scheduled');
    const full = endBasalSegment(l, T0 + 90 * MIN);
    expect(full.doses[0]).toMatchObject({ durationMin: 60 });
  });

  it('reports an open suspend with its duration so far', () => {
    const l = suspendDelivery(emptyLedger(), T0);
    expect(ledgerHistory(l, 0, T0 + 5 * MIN)[0]).toMatchObject({ kind: 'suspend', durationMin: 5 });
    const done = resumeDelivery(l, T0 + 8 * MIN);
    expect(ledgerHistory(done, 0, T0 + 30 * MIN)[0]).toMatchObject({ kind: 'suspend', durationMin: 8 });
  });
});

describe('resolving unacknowledged commands', () => {
  const status = (over: Partial<StatusResponseBlock>): StatusResponseBlock => ({
    type: 'statusResponse',
    deliveryStatus: DeliveryStatus.scheduledBasal,
    podProgress: PodProgress.aboveFiftyUnits,
    timeActive: 0,
    reservoirLevel: 51.15,
    insulinDelivered: 0,
    bolusNotDelivered: 0,
    lastProgrammingMessageSeqNum: 0,
    alerts: 0,
    ...over,
  });
  const bolus = (messageNumber: number, priorProgSeq: number | null): PendingCommand => ({ kind: 'bolus', messageNumber, sentAt: T0, priorProgSeq, units: 1, automatic: false, id: 'b' });

  it('a different programming sequence number means the pod did not get the command', () => {
    expect(resolvePending(bolus(6, 4), status({ lastProgrammingMessageSeqNum: 4 }))).toBe('notReceived');
  });

  it('a matching sequence number means the pod received it', () => {
    expect(resolvePending(bolus(6, 4), status({ lastProgrammingMessageSeqNum: 6 }))).toBe('received');
    expect(resolvePending(bolus(6, null), status({ lastProgrammingMessageSeqNum: 6 }))).toBe('received');
  });

  it('an ambiguous match (4-bit sequence wrap-around) needs evidence from the delivery status', () => {
    const ambiguous = bolus(6, 6);
    expect(resolvePending(ambiguous, status({ lastProgrammingMessageSeqNum: 6 }))).toBe('unknown');
    expect(resolvePending(ambiguous, status({ lastProgrammingMessageSeqNum: 6, deliveryStatus: DeliveryStatus.bolusInProgress }))).toBe('received');
    const temp: PendingCommand = { kind: 'tempBasal', messageNumber: 2, sentAt: T0, priorProgSeq: 2, rate: 1, durationMin: 30 };
    expect(resolvePending(temp, status({ lastProgrammingMessageSeqNum: 2 }))).toBe('unknown');
    expect(resolvePending(temp, status({ lastProgrammingMessageSeqNum: 2, deliveryStatus: DeliveryStatus.tempBasalRunning }))).toBe('received');
    const cancel: PendingCommand = { kind: 'cancel', messageNumber: 2, sentAt: T0, priorProgSeq: 2, deliveryType: CancelDeliveryType.all };
    expect(resolvePending(cancel, status({ lastProgrammingMessageSeqNum: 2 }))).toBe('unknown');
  });
});

describe('advertisements and discovery', () => {
  const ad = (uuids: string[]) => ({ id: 'x', name: null, rssi: -50, serviceUuids: uuids, manufacturerData: null });

  it('recognises an unpaired pod and decodes the advertised pod id', () => {
    const unpaired = parseAdvertisement(ad(advertisementUuids(0xfffffffe, 135438353, 792407)));
    expect(unpaired).toMatchObject({ pairable: true, podId: 0xfffffffe });
    const paired = parseAdvertisement(ad(advertisementUuids(0x17244389, 135438353, 792407)));
    expect(paired).toMatchObject({ pairable: false, podId: 0x17244389 });
  });

  it('ignores other devices and accepts 16-bit UUIDs in either form', () => {
    expect(parseAdvertisement(ad([DASH_ADVERTISEMENT_UUID]))).toBeNull();
    expect(parseAdvertisement(ad(['180f']))).toBeNull();
    expect(shortUuid('00004024-0000-1000-8000-00805f9b34fb')).toBe('4024');
    expect(shortUuid('000a')).toBe('000A');
    const short = advertisementUuids(0xfffffffe, 1, 2).map(shortUuid);
    expect(parseAdvertisement(ad(short))?.pairable).toBe(true);
  });
});

describe('persisted record', () => {
  it('survives garbage in the store without ever producing invalid state', () => {
    const r = parseRecord(JSON.stringify({ version: 1, ltk: 'nothex', setupProgress: 'bogus', transport: { ck: 'zz', msgSeq: 999, messageNumber: 99 }, ledger: { doses: [{ kind: 'bolus', units: -1, id: 'x', date: 1 }, 7], bolus: 'x', basal: { kind: 'temp' }, pending: { kind: 'bolus' } } }));
    expect(r.ltk).toBeNull();
    expect(r.setupProgress).toBe('none');
    expect(r.transport.ck).toBeNull();
    expect(r.transport.msgSeq).toBeLessThanOrEqual(0xff);
    expect(r.transport.messageNumber).toBeLessThanOrEqual(0xf);
    expect(r.ledger).toEqual({ doses: [], bolus: null, basal: { kind: 'scheduled' }, pending: null });
    expect(() => parseRecord(JSON.stringify({ version: 2 }))).toThrow(/Unsupported/);
  });

  it('round-trips a record', () => {
    const rec = { ...initialRecord(), ltk: 'ab'.repeat(16), podId: 5, setupProgress: 'completed' as const };
    expect(parseRecord(JSON.stringify(rec))).toEqual(rec);
  });
});

describe('pairing dialogue against the simulator', () => {
  it('builds the SP1/SP2 message byte for byte like the PDM', () => {
    const msg = pairMessage(1, 0x1781fc00, 0xfffffffe, ['SP1=', ',SP2='], [fromHex('1781fc01'), GET_POD_STATUS_HEX_COMMAND]);
    expect(hex(encodeMessagePacket(msg))).toBe('54571003010003801781fc00fffffffe5350313d00041781fc012c5350323d000bffc32dbd08030e0100008a');
  });

  it('derives the same LTK on both sides, and the pod only accepts the right confirmation', async () => {
    const clock = { now: () => 0 };
    const ble = createFakeBle();
    const sim = new OmnipodDashSimulator({ clock });
    ble.add(sim);
    const conn = await ble.transport.connect(sim.id);
    const link = new PodLink(conn, { ioTimeoutMs: 200, log: silentLogger });
    await link.hello(0x1781fc00);
    const ke = new DashKeyExchange();
    const result = await negotiateLtk(link, { myId: 0x1781fc00, podId: 0x1781fc01 }, ke);
    expect(result.ltk).toHaveLength(16);
    expect(result.msgSeq).toBe(4);
    expect(sim.serviceUuids.map((u) => shortUuid(u))[3]).toBe('1781');
    await link.close();
  });

  it('fails the pairing when the pod answers with a different confirmation', async () => {
    const clock = { now: () => 0 };
    const ble = createFakeBle();
    const sim = new OmnipodDashSimulator({ clock });
    ble.add(sim);
    const conn = await ble.transport.connect(sim.id);
    const link = new PodLink(conn, { ioTimeoutMs: 100, log: silentLogger });
    await link.hello(0x1781fc00);
    class BadExchange extends DashKeyExchange {
      override get pdmConf() {
        return new Uint8Array(16); // the pod cannot confirm this
      }
    }
    await expect(negotiateLtk(link, { myId: 0x1781fc00, podId: 0x1781fc01 }, new BadExchange())).rejects.toThrow();
    await link.close();
  });
});
