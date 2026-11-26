/**
 * Omnipod shared message layer against byte vectors taken from OmnipodKit's tests
 * (MIT License, (c) LoopKit Authors): MessageTests, StatusTests, TempBasalTests, BasalScheduleTests,
 * BolusTests, AcknowledgeAlertsTests, PodInfoTests and CRC16Tests.
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import {
  AlertSlot,
  BeepRepeat,
  BeepType,
  CancelDeliveryType,
  DeliveryStatus,
  POD,
  PodInfoType,
  PodProgress,
  alertSetHas,
  alertSetOf,
  basalScheduleBlocks,
  basalScheduleFromBuddy,
  bolusScheduleBlocks,
  crc16,
  decodeBlock,
  decodeMessage,
  encodeBlock,
  encodeMessage,
  expiredAlert,
  makeMessage,
  messageFault,
  roundToSupportedBasalRate,
  tempBasalBlocks,
  type MessageBlock,
} from '../src/omnipod/common';
import type { DetailedStatus, SetInsulinScheduleBlock } from '../src/omnipod/common';

const h = (block: MessageBlock): string => hex(encodeBlock(block));
const decode = (s: string): MessageBlock => decodeBlock(fromHex(s)).block;
const HOUR = 3600;
const MIN = 60;

describe('CRC16 and message framing', () => {
  it('computes the OmnipodKit CRC16', () => {
    expect(crc16(fromHex('1f01482a10030e0100'))).toBe(0x802c);
  });

  it('encodes a GetStatus message', () => {
    const msg = makeMessage(0x1f01482a, [{ type: 'getStatus', podInfoType: PodInfoType.normal }], 4);
    expect(hex(encodeMessage(msg))).toBe('1f01482a10030e0100802c');
  });

  it('decodes a status message and re-encodes it identically', () => {
    const raw = '1f00ee84300a1d18003f1800004297ff8128';
    const msg = decodeMessage(fromHex(raw));
    expect(msg.address).toBe(0x1f00ee84);
    expect(msg.sequenceNum).toBe(12);
    const s = msg.blocks[0]!;
    if (s.type !== 'statusResponse') throw new Error('expected status');
    expect(s.reservoirLevel).toBeCloseTo(POD.reservoirLevelAboveThresholdMagicNumber, 2);
    expect(s.timeActive).toBe(4261 * MIN);
    expect(s.deliveryStatus).toBe(DeliveryStatus.scheduledBasal);
    expect(s.podProgress).toBe(PodProgress.aboveFiftyUnits);
    expect(s.insulinDelivered).toBeCloseTo(6.3, 2);
    expect(s.bolusNotDelivered).toBe(0);
    expect(s.lastProgrammingMessageSeqNum).toBe(3);
    expect(s.alerts).toBe(0);
    expect(hex(encodeMessage(msg))).toBe(raw);
  });

  it('rejects a corrupted CRC and a truncated message', () => {
    expect(() => decodeMessage(fromHex('1f00ee84300a1d18003f1800004297ff8129'))).toThrow(/CRC/);
    expect(() => decodeMessage(fromHex('1f00ee84300a'))).toThrow(/Not enough/);
  });

  it('keeps the follow-on flag and 4-bit sequence number', () => {
    const msg = makeMessage(0xffffffff, [{ type: 'assignAddress', address: 0x1f01482a }], 0b1011, true);
    const back = decodeMessage(encodeMessage(msg));
    expect(back.sequenceNum).toBe(0b1011);
    expect(back.expectFollowOnMessage).toBe(true);
  });
});

describe('status and version responses', () => {
  it('decodes a status with 46 U left', () => {
    const s = decode('1d19050ec82c08376f9801dc');
    if (s.type !== 'statusResponse') throw new Error();
    expect(s.timeActive).toBe(3547 * MIN);
    expect(s.deliveryStatus).toBe(DeliveryStatus.scheduledBasal);
    expect(s.podProgress).toBe(PodProgress.fiftyOrLessUnits);
    expect(s.insulinDelivered).toBeCloseTo(129.45, 2);
    expect(s.reservoirLevel).toBe(46);
    expect(s.bolusNotDelivered).toBeCloseTo(2.2, 5);
    expect(s.lastProgrammingMessageSeqNum).toBe(9);
    expect(hex(encodeBlock(s))).toBe('1d19050ec82c08376f98');
  });

  it('decodes alerts of a status', () => {
    const s = decode('1d28008200004446ebff');
    if (s.type !== 'statusResponse') throw new Error();
    expect(alertSetHas(s.alerts, AlertSlot.expirationReminder)).toBe(true);
    expect(alertSetHas(s.alerts, AlertSlot.expired)).toBe(true);
    expect(alertSetHas(s.alerts, AlertSlot.lowReservoir)).toBe(false);
  });

  it('decodes the short DASH version response (assign address)', () => {
    const v = decode('0115031b0008080004020812a011000c175700ffffffff');
    if (v.type !== 'versionResponse') throw new Error();
    expect(v).toMatchObject({ firmwareVersion: '3.27.0', iFirmwareVersion: '8.8.0', podModel: 4, lot: 135438353, tid: 792407, address: 0xffffffff, podProgress: PodProgress.reminderInitialized, setup: null });
    expect(hex(encodeBlock(v))).toBe('0115031b0008080004020812a011000c175700ffffffff');
  });

  it('decodes the long DASH version response (setup pod) inside a message', () => {
    const msg = decodeMessage(fromHex('ffffffff0c1d011b13881008340a50031b0008080004030812a011000c175717244389816c'));
    const v = msg.blocks[0]!;
    if (v.type !== 'versionResponse') throw new Error();
    expect(v.address).toBe(0x17244389);
    expect(v.podProgress).toBe(PodProgress.pairingCompleted);
    expect(v.setup).toEqual({ pulseSize: 0.05, secondsPerBolusPulse: 2, secondsPerPrimePulse: 1, primeUnits: 2.6, cannulaInsertionUnits: 0.5, serviceDuration: POD.serviceDuration });
    expect(hex(encodeMessage(msg))).toBe('ffffffff0c1d011b13881008340a50031b0008080004030812a011000c175717244389816c');
  });

  it('decodes the Eros version responses (the common layer is shared)', () => {
    const short = decode('011502070002070002020000a64000097c279c1f08ced2');
    if (short.type !== 'versionResponse') throw new Error();
    expect(short).toMatchObject({ firmwareVersion: '2.7.0', podModel: 2, lot: 42560, tid: 621607, address: 0x1f08ced2, podProgress: PodProgress.reminderInitialized });
  });

  it('decodes error responses', () => {
    const bad = decode('060314abcd');
    expect(bad).toEqual({ type: 'errorResponse', error: { kind: 'badNonce', nonceResyncKey: 0xabcd } });
  });
});

describe('detailed status and pod info', () => {
  const detailed = (s: string): DetailedStatus => {
    const b = decode(s);
    if (b.type !== 'podInfoResponse' || b.info.podInfoType !== PodInfoType.detailedStatus) throw new Error('expected detailed status');
    return b.info;
  };

  it('decodes an occlusion fault', () => {
    const d = detailed('0216020d0000000000ab6a038403ff03860000285708030d0000');
    expect(d.podProgress).toBe(PodProgress.faultEventOccurred);
    expect(d.deliveryStatus).toBe(DeliveryStatus.suspended);
    expect(d.totalInsulinDelivered).toBeCloseTo(8.55, 5);
    expect(d.faultEventCode.name).toBe('occlusionCheckAboveThreshold');
    expect(d.faultEventTimeSinceActivation).toBe(0x384 * 60);
    expect(d.reservoirLevel).toBeCloseTo(51.15, 2);
    expect(d.timeActive).toBe(0x386 * 60);
    expect(d.errorEventInfo).toMatchObject({ insulinStateTableCorruption: false, occlusionType: 1, immediateBolusInProgress: false, podProgress: PodProgress.aboveFiftyUnits });
    expect(d.receiverLowGain).toBe(1);
    expect(d.radioRSSI).toBe(0x17);
  });

  it('decodes a fault after 42 h and recognises it as a message fault', () => {
    const body = '020d0000000407f28609ff03ff0a0200000823080000';
    const d = detailed(`0216${body}`);
    expect(d.faultEventCode.name).toBe('basalOverInfusionPulse');
    expect(d.lastProgrammingMessageSeqNum).toBe(4);
    expect(d.totalInsulinDelivered).toBeCloseTo(101.7, 2);
    expect(d.faultEventTimeSinceActivation).toBe(0x09ff * 60);
    expect(d.previousPodProgress).toBe(PodProgress.aboveFiftyUnits);
    const msg = makeMessage(0x1f00ee84, [decode(`0216${body}`)], 1);
    expect(messageFault(decodeMessage(encodeMessage(msg)))?.faultEventCode.name).toBe('basalOverInfusionPulse');
  });

  it('round-trips a detailed status block', () => {
    const raw = `0216${'020d0000000407f28609ff03ff0a0200000823080000'}`;
    const b = decode(raw);
    expect(hex(encodeBlock(b))).toBe(raw);
  });

  it('decodes activation time and empty triggered alerts', () => {
    const a = decode('0213059200010000000000000000091912170e');
    if (a.type !== 'podInfoResponse' || a.info.podInfoType !== PodInfoType.activationTime) throw new Error();
    expect(a.info.faultEventCode.name).toBe('tempPulseChanInactive');
    expect(a.info.faultTime).toBe(60);
    expect(a.info.date).toEqual({ year: 18, month: 9, day: 25, hour: 23, minute: 14 });
    const t = decode('0213' + '01000000000000000000000000000000000000');
    if (t.type !== 'podInfoResponse') throw new Error();
    expect(t.podInfoType).toBe(PodInfoType.triggeredAlerts);
  });
});

describe('commands', () => {
  it('encodes status requests', () => {
    expect(h({ type: 'getStatus', podInfoType: PodInfoType.normal })).toBe('0e0100');
    expect(h({ type: 'getStatus', podInfoType: PodInfoType.triggeredAlerts })).toBe('0e0101');
    expect(h({ type: 'getStatus', podInfoType: PodInfoType.detailedStatus })).toBe('0e0102');
    expect(decode('0e0102')).toEqual({ type: 'getStatus', podInfoType: PodInfoType.detailedStatus });
  });

  it('encodes AssignAddress and SetupPod', () => {
    expect(h({ type: 'assignAddress', address: 0x1f01482a })).toBe('07041f01482a');
    const setup = { type: 'setupPod', address: 0x1f0218c3, lot: 0x0000a4be, tid: 0x0004e4a1, packetTimeoutLimit: 4, date: { year: 2016, month: 6, day: 12, hour: 13, minute: 47 } } as const;
    expect(h(setup)).toBe('03131f0218c31404060c100d2f0000a4be0004e4a1');
    expect(decode('03131f0218c31404060c100d2f0000a4be0004e4a1')).toEqual(setup);
  });

  it('encodes acknowledge alerts', () => {
    expect(h({ type: 'acknowledgeAlert', nonce: 0x2f9b5b2f, alerts: alertSetOf(AlertSlot.lowReservoir) })).toBe('11052f9b5b2f10');
    expect(h({ type: 'acknowledgeAlert', nonce: 0x494e532e, alerts: alertSetOf(AlertSlot.expired, AlertSlot.expirationReminder) })).toBe('1105494e532e88');
  });

  it('encodes prime and cannula insertion boluses', () => {
    const [sched, extra] = bolusScheduleBlocks(0xbed2e16b, POD.primeUnits, POD.secondsPerPrimePulse);
    expect(h(sched)).toBe('1a0ebed2e16b02010a0101a000340034');
    expect(h(extra)).toBe('170d000208000186a0000000000000');
    const [cannula] = bolusScheduleBlocks(0x7e30bf16, POD.cannulaInsertionUnits, POD.secondsPerPrimePulse);
    expect(h(cannula)).toBe('1a0e7e30bf16020065010050000a000a');
    const back = decode('1a0e7e30bf16020065010050000a000a') as SetInsulinScheduleBlock;
    expect(back.schedule).toMatchObject({ kind: 'bolus', units: 0.5, timeBetweenPulses: 1 });
  });

  it('encodes and decodes a 30 U bolus extra command', () => {
    const [, extra] = bolusScheduleBlocks(0, 30, POD.secondsPerBolusPulse);
    const withBeeps = { ...extra, completionBeep: true, programReminderInterval: HOUR };
    expect(h(withBeeps)).toBe('170d7c177000030d40000000000000');
    expect(decode('170d7c177000030d40000000000000')).toMatchObject({ units: 30, completionBeep: true, acknowledgementBeep: false, programReminderInterval: HOUR, timeBetweenPulses: 2 });
  });

  it('validates the delivery schedule checksum', () => {
    expect(() => decode('1a0ebed2e16b02010b0101a000340034')).toThrow(/checksum/);
  });

  it('encodes temp basals (alternating pulses and durations)', () => {
    const t = (rate: number, hours: number) => h(tempBasalBlocks(0x9746c65b, rate, hours * HOUR, 0.01)[0]);
    expect(t(0.05, 0.5)).toBe('1a0e9746c65b01007901384000000000');
    expect(t(0.05, 8.5)).toBe('1a109746c65b0100911138400000f8000000');
    expect(t(0.05, 16.5)).toBe('1a129746c65b0100a92138400000f800f8000000');
    expect(h(tempBasalBlocks(0xeac79411, 0.3, 0.5 * HOUR, 0.01)[0])).toBe('1a0eeac7941101007f01384000030003');
    expect(h(tempBasalBlocks(0x87e8d03a, 2, 1.5 * HOUR, 0.01)[0])).toBe('1a0e87e8d03a0100cb03384000142014');
    expect(h(tempBasalBlocks(0x4e2c2717, 0.05, 2.5 * HOUR, 0.01)[0])).toBe('1a0e4e2c271701007f05384000004800');
    const decoded = decode('1a0e4e2c271701007f05384000004800') as SetInsulinScheduleBlock;
    expect(decoded.schedule).toMatchObject({ kind: 'tempBasal', secondsRemaining: 1800, firstSegmentPulses: 0, table: [{ segments: 5, pulses: 0, alternateSegmentPulse: true }] });
  });

  it('encodes the DASH zero temp extra command with the near-zero rate', () => {
    const [, extra] = tempBasalBlocks(0, 0, 0.5 * HOUR, 0.01);
    expect(h({ ...extra, completionBeep: true, programReminderInterval: HOUR })).toBe('160e7c0000016b49d2000001eb49d200');
    const [, three] = tempBasalBlocks(0, 0, 3 * HOUR, 0.01);
    expect(h({ ...three, completionBeep: true, programReminderInterval: HOUR })).toBe('160e7c0000066b49d2000006eb49d200');
    const dec = decode('160e7c0000016b49d2000001eb49d200');
    expect(dec).toMatchObject({ type: 'tempBasalExtra', completionBeep: true, remainingPulses: 0.1, delayUntilFirstPulse: 5 * HOUR });
  });

  it('encodes cancel delivery and deactivate', () => {
    expect(h({ type: 'cancelDelivery', nonce: 0xf76d34c4, deliveryType: CancelDeliveryType.tempBasal, beepType: BeepType.beeeeeep })).toBe('1f05f76d34c462');
    expect(h({ type: 'cancelDelivery', nonce: 0xf76d34c4, deliveryType: CancelDeliveryType.tempBasal, beepType: BeepType.noBeepCancel })).toBe('1f05f76d34c402');
    expect(decode('1f05f76d34c462')).toMatchObject({ nonce: 0xf76d34c4, deliveryType: CancelDeliveryType.tempBasal, beepType: BeepType.beeeeeep });
    expect(h({ type: 'deactivatePod', nonce: 0x494e532e })).toBe('1c04494e532e');
  });

  it('encodes alert configurations', () => {
    const cfg0 = { slot: AlertSlot.autoOff, active: false, duration: 15 * MIN, trigger: { kind: 'timeUntilAlert', seconds: 0 }, beepRepeat: BeepRepeat.every1MinuteFor15Minutes, beepType: BeepType.bipBeepBipBeepBipBeepBipBeep, silent: false, autoOffModifier: true } as const;
    const cfg2 = { slot: AlertSlot.shutdownImminent, active: true, duration: 0, trigger: { kind: 'timeUntilAlert', seconds: 79 * HOUR - MIN }, beepRepeat: BeepRepeat.every15Minutes, beepType: BeepType.bipBeepBipBeepBipBeepBipBeep, silent: false, autoOffModifier: false } as const;
    const cfg7 = expiredAlert(0, 72 * HOUR - MIN, 7 * HOUR, false);
    const block = { type: 'configureAlerts', nonce: 0xfeb6268b, configurations: [cfg0, cfg2, cfg7] } as const;
    expect(h(block)).toBe('1916feb6268b020f0000020228001283060279a410df0502');
    const decoded = decode('1916feb6268b79a410df0502280012830602020f00000202');
    if (decoded.type !== 'configureAlerts') throw new Error();
    expect(decoded.configurations).toHaveLength(3);
    expect(decoded.configurations[0]).toMatchObject({ slot: AlertSlot.expired, active: true, autoOffModifier: false, duration: 7 * HOUR, trigger: { kind: 'timeUntilAlert', seconds: 72 * HOUR - MIN } });
    const low = decode('19' + '0a' + '00000000' + '4c0000640102');
    if (low.type !== 'configureAlerts') throw new Error();
    expect(low.configurations[0]).toMatchObject({ slot: AlertSlot.lowReservoir, active: true, trigger: { kind: 'unitsRemaining', units: 10 }, beepRepeat: BeepRepeat.every1MinuteFor3MinutesAndRepeatEvery60Minutes });
  });
});

describe('basal schedule', () => {
  it('rounds to supported rates', () => {
    expect(roundToSupportedBasalRate(0.3)).toBeCloseTo(0.3, 10);
    expect(roundToSupportedBasalRate(0.07)).toBeCloseTo(0.05, 10);
    expect(roundToSupportedBasalRate(99)).toBe(30);
    expect(roundToSupportedBasalRate(0)).toBe(0);
  });

  it('builds the 0.05 U/h schedule command at 08:15 like OmnipodKit (Eros)', () => {
    const schedule = basalScheduleFromBuddy([{ startMinute: 0, value: 0.05 }], 0);
    const [set] = basalScheduleBlocks(0x01020304, schedule, 8.25 * HOUR, 0);
    expect(h(set)).toBe('1a1201020304000064101c200000f800f800f800');
    expect(set.schedule).toMatchObject({ kind: 'basalSchedule', currentSegment: 16, secondsRemaining: 15 * MIN, pulsesRemaining: 0 });
  });

  it('round-trips a basal schedule command and builds the extra command', () => {
    const raw = '1a1277a055510000622b17080000f800f800f800';
    expect(h(decode(raw))).toBe(raw);
    const [, extra] = basalScheduleBlocks(1, basalScheduleFromBuddy([{ startMinute: 0, value: 3 }], 0), 0, 0);
    expect(extra.rateEntries).toEqual([{ totalPulses: 1440, delayBetweenPulses: 60 }]);
    expect(hex(encodeBlock({ ...extra, completionBeep: true, remainingPulses: 689, delayUntilNextTenthOfPulse: 20, currentEntryIndex: 0 }))).toBe('130e40001aea01312d003840005b8d80');
  });

  it('validates schedules', () => {
    expect(() => basalScheduleFromBuddy([], 0.01)).toThrow(/empty/);
    expect(() => basalScheduleFromBuddy([{ startMinute: 30, value: 1 }], 0.01)).toThrow(/00:00/);
    expect(() => basalScheduleFromBuddy([{ startMinute: 0, value: 31 }], 0.01)).toThrow(/outside/);
    expect(() => basalScheduleFromBuddy([{ startMinute: 0, value: 1 }, { startMinute: 45, value: 1 }], 0.01)).toThrow(/half hours/);
  });
});

describe('round trips', () => {
  it('encodes and decodes the beep config command', () => {
    const block = { type: 'beepConfig', beepType: BeepType.bipBip, basalCompletionBeep: false, basalIntervalBeep: 0, tempBasalCompletionBeep: true, tempBasalIntervalBeep: 0, bolusCompletionBeep: true, bolusIntervalBeep: 15 * MIN } as const;
    expect(h(block)).toBe('1e040300404f');
    expect(decode(h(block))).toEqual(block);
  });

  it('round-trips status responses over the whole field range', () => {
    for (let i = 0; i < 300; i++) {
      const s = {
        type: 'statusResponse',
        deliveryStatus: [0, 1, 2, 4, 5, 6, 8, 9, 10][i % 9] as DeliveryStatus,
        podProgress: (i % 16) as PodProgress,
        timeActive: ((i * 977) % 5000) * 60,
        reservoirLevel: ((i * 13) % 1023) / 20,
        insulinDelivered: ((i * 31) % 4095) / 20,
        bolusNotDelivered: ((i * 7) % 1023) / 20,
        lastProgrammingMessageSeqNum: i % 16,
        alerts: (i * 37) % 256,
      } as const;
      expect(decode(h(s))).toEqual(s);
    }
  });

  it('rejects unknown and truncated blocks', () => {
    expect(() => decode('ff0100')).toThrow(/Unknown block/);
    expect(() => decode('0e01')).toThrow(/Not enough/);
    expect(() => decode('1a0e00')).toThrow(/Not enough/);
    expect(() => decode('1d0100')).toThrow(/Not enough/);
  });
});
