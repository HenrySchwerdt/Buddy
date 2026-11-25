/**
 * Packet generation tests ported from DanaKitTests/GeneratePacketTests.swift of
 * loopandlearn/DanaKit (MIT, © original authors), same bytes, for the packets the Buddy driver
 * uses; plus parsing tests for the responses it reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BolusSpeed,
  danaBasalCancelTemporary,
  danaBasalGetRate,
  danaBasalSetSuspendOff,
  danaBasalSetSuspendOn,
  danaBasalSetTemporary,
  danaBolusGetStepInformation,
  danaBolusStart,
  danaBolusStop,
  danaGeneralGetInitialScreenInformation,
  danaGeneralGetPumpTime,
  danaGeneralGetPumpTimeUtcWithTimezone,
  danaGeneralKeepConnection,
  danaGeneralSetHistoryUploadMode,
  danaGeneralSetPumpTime,
  danaGeneralSetPumpTimeUtcWithTimezone,
  danaHistoryAll,
  danaHistoryBolus,
  danaLoopSetTemporaryBasal,
  HistoryCode,
  LoopTempBasalDuration,
  parseHistory,
  parseNotifyAlarm,
  parseNotifyDeliveryComplete,
  parseNotifyDeliveryRateDisplay,
  transformBolusError,
} from '../src/dana/packets';
import { absoluteBasalRateToPercentage, percentToRate, planTempBasal, roundToSupportedBolusVolume } from '../src/dana/temp-basal';
import { parsePincodes } from '../src/dana/link';
import { parsePersisted } from '../src/dana/persisted';

const bytes = (b: Uint8Array) => Array.from(b);
// 2023-12-05T11:00:00.000 UTC
const DATE = 1_701_774_000 * 1000;

// The Swift expectations for local-time packets were recorded in Europe/Amsterdam (UTC+1)
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = 'Europe/Amsterdam';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('Dana packet generation (GeneratePacketTests.swift)', () => {
  const empty: [string, { opCode: number; generate(): Uint8Array }, number][] = [
    ['BasalCancelTemporary', danaBasalCancelTemporary(), 98],
    ['BasalGetRate', danaBasalGetRate(), 103],
    ['BasalSetSuspendOff', danaBasalSetSuspendOff(), 106],
    ['BasalSetSuspendOn', danaBasalSetSuspendOn(), 105],
    ['BolusGetStepInformation', danaBolusGetStepInformation(), 64],
    ['BolusStop', danaBolusStop(), 68],
    ['GeneralGetInitialScreenInformation', danaGeneralGetInitialScreenInformation(), 2],
    ['GeneralGetPumpTime', danaGeneralGetPumpTime(), 112],
    ['GeneralGetPumpTimeWithUtc', danaGeneralGetPumpTimeUtcWithTimezone(), 120],
    ['GeneralKeepConnection', danaGeneralKeepConnection(), 255],
  ];
  it.each(empty)('%s has opcode and no data', (_n, packet, opCode) => {
    expect(packet.opCode).toBe(opCode);
    expect(packet.generate().length).toBe(0);
  });

  it('BasalSetTemporary', () => {
    const p = danaBasalSetTemporary({ temporaryBasalRatio: 200, temporaryBasalDuration: 1 });
    expect(p.opCode).toBe(96);
    expect(bytes(p.generate())).toEqual([200, 1]);
  });

  it.each([
    [BolusSpeed.speed12, 0],
    [BolusSpeed.speed30, 1],
    [BolusSpeed.speed60, 2],
  ])('BolusStart speed %i', (speed, byte) => {
    const p = danaBolusStart({ amount: 5, speed });
    expect(p.opCode).toBe(74);
    expect(bytes(p.generate())).toEqual([244, 1, byte]);
  });

  it('BolusStart never rounds up and survives float artefacts', () => {
    expect(bytes(danaBolusStart({ amount: 0.29, speed: BolusSpeed.speed12 }).generate())).toEqual([29, 0, 0]);
    expect(bytes(danaBolusStart({ amount: 0.057, speed: BolusSpeed.speed12 }).generate())).toEqual([5, 0, 0]);
  });

  it('SetHistoryUploadMode on/off', () => {
    expect(danaGeneralSetHistoryUploadMode({ mode: 0 }).opCode).toBe(37);
    expect(bytes(danaGeneralSetHistoryUploadMode({ mode: 0 }).generate())).toEqual([0]);
    expect(bytes(danaGeneralSetHistoryUploadMode({ mode: 1 }).generate())).toEqual([1]);
  });

  it('SetPumpTime (local time)', () => {
    const p = danaGeneralSetPumpTime({ time: DATE });
    expect(p.opCode).toBe(113);
    expect(bytes(p.generate())).toEqual([23, 12, 5, 12, 0, 0]);
  });

  it('SetPumpTimeWithTimezone (UTC)', () => {
    const p = danaGeneralSetPumpTimeUtcWithTimezone({ time: DATE, zoneOffset: 1 });
    expect(p.opCode).toBe(121);
    expect(bytes(p.generate())).toEqual([23, 12, 5, 11, 0, 0, 1]);
  });

  it('History packets with and without a from date', () => {
    expect(danaHistoryAll({ from: null, usingUtc: true }).opCode).toBe(31);
    expect(bytes(danaHistoryAll({ from: null, usingUtc: true }).generate())).toEqual([0, 1, 1, 0, 0, 0]);
    expect(danaHistoryBolus({ from: null, usingUtc: true }).opCode).toBe(17);
    expect(bytes(danaHistoryBolus({ from: DATE, usingUtc: true }).generate())).toEqual([23, 12, 5, 11, 0, 0]);
  });

  it('LoopSetTemporaryBasal and the 500 % cap', () => {
    const p = danaLoopSetTemporaryBasal({ percent: 200, duration: LoopTempBasalDuration.min30 });
    expect(p.opCode).toBe(193);
    expect(bytes(p.generate())).toEqual([200, 0, 160]);
    expect(bytes(danaLoopSetTemporaryBasal({ percent: 750, duration: LoopTempBasalDuration.min15 }).generate())).toEqual([244, 1, 150]);
  });
});

describe('Dana response parsing', () => {
  const msg = (opCode: number, payload: number[], type = 0xb2) => new Uint8Array([type, opCode, ...payload]);

  it('InitialScreenInformation', () => {
    const r = danaGeneralGetInitialScreenInformation().parse(msg(2, [0x11, 0x10, 0x00, 0xa0, 0x0f, 0xb8, 0x88, 0x50, 0x00, 150, 77, 0, 0, 0x2c, 0x01, 3]), true);
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      isPumpSuspended: true,
      isTempBasalInProgress: true,
      dailyTotalUnits: 0.16,
      maxDailyTotalUnits: 40,
      reservoirRemainingUnits: 350,
      currentBasal: 0.8,
      tempBasalPercent: 150,
      batteryRemaining: 77,
      insulinOnBoard: 3,
      errorState: 3,
    });
    expect(danaGeneralGetInitialScreenInformation().parse(msg(2, [0]), true).success).toBe(false);
  });

  it('BasalGetRate', () => {
    const r = danaBasalGetRate().parse(msg(0x67, [0x2c, 0x01, 1, ...Array.from({ length: 24 }, (_, i) => [50 + i, 0]).flat()]), true);
    expect(r.success).toBe(true);
    expect(r.data?.maxBasal).toBe(3);
    expect(r.data?.basalProfile[0]).toBe(0.5);
    expect(r.data?.basalProfile[23]).toBe(0.73);
    expect(danaBasalGetRate().parse(msg(0x67, [1, 2, 3]), true).success).toBe(false);
  });

  it('status-byte responses and bolus error codes', () => {
    expect(danaBolusStart({ amount: 1, speed: 0 }).parse(msg(0x4a, [0]), true).success).toBe(true);
    expect(danaBolusStart({ amount: 1, speed: 0 }).parse(msg(0x4a, [0x10]), true).success).toBe(false);
    expect(transformBolusError(0x01)).toBe('Pump is suspended');
    expect(transformBolusError(0x80)).toBe('Insulin limit violation');
  });

  it('pump time (UTC + zone)', () => {
    const r = danaGeneralGetPumpTimeUtcWithTimezone().parse(msg(0x78, [23, 12, 5, 11, 0, 0, 1]), true);
    // UTC 11:00 + 1 h, read as Amsterdam local time → 11:00 UTC
    expect(r.data).toEqual({ time: DATE, timezoneOffset: 1 });
    expect(danaGeneralGetPumpTimeUtcWithTimezone().parse(msg(0x78, [23, 12, 5, 11, 0, 0, 0xff]), true).data?.timezoneOffset).toBe(-1);
  });

  it('history records', () => {
    // Layout as DanaKit reads it: [code, YY, MM, DD, hh, mm, ss (= param7), param8, value hi, value lo]
    const bolus = parseHistory(msg(0x1f, [HistoryCode.RECORD_TYPE_BOLUS, 23, 12, 5, 11, 0, 30, 0x81, 0x01, 0xf4]), true);
    expect(bolus.data).toMatchObject({ code: 2, timestamp: DATE + 30_000, bolusType: 'S', durationInMin: 90 });
    expect(bolus.data?.value).toBeCloseTo(5);
    // (param8 & 0x0F) * 60 overflows UInt8 in Swift (trap); full integer math here
    expect(parseHistory(msg(0x1f, [2, 23, 12, 5, 11, 0, 0, 0x8f, 0, 1]), true).data?.durationInMin).toBe(900);
    const suspend = parseHistory(msg(0x1f, [HistoryCode.RECORD_TYPE_SUSPEND, 23, 12, 5, 11, 0, 0, 0x4f, 0, 0]), true);
    expect(suspend.data).toMatchObject({ code: 9, value: 1 });
    const done = parseHistory(msg(0x1f, [0, 0, 0]), true);
    expect(done).toMatchObject({ success: true, data: { code: HistoryCode.RECORD_TYPE_DONE_UPLOAD } });
    expect(parseHistory(msg(0x1f, [0x55, 23, 12, 5, 11, 0, 0, 0, 0, 0]), true).success).toBe(false);
    expect(parseHistory(msg(0x1f, [2, 23, 12]), true).success).toBe(false);
  });

  it('notifications', () => {
    expect(parseNotifyDeliveryComplete(msg(1, [0x32, 0x00], 0xc3)).data?.deliveredInsulin).toBe(0.5);
    expect(parseNotifyDeliveryRateDisplay(msg(2, [0x0a, 0x00], 0xc3)).data?.deliveredInsulin).toBe(0.1);
    expect(parseNotifyAlarm(msg(3, [0x03], 0xc3)).data).toEqual({ code: 3, alert: 'occlusion' });
    expect(parseNotifyAlarm(msg(3, [0x77], 0xc3)).data?.alert).toBe('unknown');
  });
});

describe('Dana dosing arithmetic (never rounds insulin up)', () => {
  const profile = Array.from({ length: 24 }, () => 0.8);
  const at = Date.UTC(2026, 0, 1, 12);

  it('U/h → percent is floored', () => {
    expect(absoluteBasalRateToPercentage(1.5, profile, at)).toBe(187); // DanaKit round() would give 188
    expect(absoluteBasalRateToPercentage(0.6, Array.from({ length: 24 }, () => 0.2), at)).toBe(300); // 299.99999999999994
    expect(absoluteBasalRateToPercentage(0, profile, at)).toBe(0);
    expect(absoluteBasalRateToPercentage(1, profile.slice(1), at)).toBeNull();
    expect(absoluteBasalRateToPercentage(1, Array.from({ length: 24 }, () => 0), at)).toBeNull();
    expect(percentToRate(187, 0.8)).toBe(1.5);
  });

  it('durations are rounded down like DanaKit', () => {
    expect(planTempBasal(150, 30)).toMatchObject({ ok: true, durationMin: 30, command: { kind: 'short', code: 160 } });
    expect(planTempBasal(150, 15)).toMatchObject({ ok: true, durationMin: 15, command: { kind: 'short', code: 150 } });
    expect(planTempBasal(150, 45)).toMatchObject({ ok: true, durationMin: 30 });
    expect(planTempBasal(150, 20)).toMatchObject({ ok: true, durationMin: 15 });
    expect(planTempBasal(150, 150)).toMatchObject({ ok: true, durationMin: 120, command: { kind: 'hours', hours: 2 } });
    expect(planTempBasal(150, 10)).toMatchObject({ ok: false });
    expect(planTempBasal(150, 25 * 60)).toMatchObject({ ok: false });
  });

  it('>200 % is shortened to 15 min and capped at 500 %', () => {
    expect(planTempBasal(250, 60)).toMatchObject({ ok: true, durationMin: 15, percent: 250, command: { kind: 'short' } });
    expect(planTempBasal(900, 30)).toMatchObject({ ok: true, durationMin: 15, percent: 500 });
  });

  it('bolus volumes are floored to 0.05 U', () => {
    expect(roundToSupportedBolusVolume(0.29)).toBe(0.25);
    expect(roundToSupportedBolusVolume(0.3)).toBe(0.3);
    expect(roundToSupportedBolusVolume(0.04)).toBe(0);
    expect(roundToSupportedBolusVolume(31)).toBe(30);
    expect(roundToSupportedBolusVolume(Number.NaN)).toBe(0);
  });
});

describe('Dana RSv3 PIN parsing (DanaKitScanViewModel.processPinPrompt)', () => {
  it('accepts PINs with a matching checksum', () => {
    const r = parsePincodes('edf1755f873d', 'b5c941' + (0xed ^ 0xf1 ^ 0x75 ^ 0x5f ^ 0x87 ^ 0x3d ^ 0xb5 ^ 0xc9 ^ 0x41).toString(16).padStart(2, '0'));
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(bytes(r.pairingKey)).toEqual([237, 241, 117, 95, 135, 61]);
      expect(bytes(r.randomPairingKey)).toEqual([181, 201, 65]);
    }
  });
  it('rejects bad lengths, hex and checksums', () => {
    expect(parsePincodes('abc', '12345678')).toEqual({ error: 'Received invalid pincode lengths. Try again' });
    expect(parsePincodes('zzzzzzzzzzzz', '12345678')).toEqual({ error: 'Received invalid hex strings. Try again' });
    expect(parsePincodes('edf1755f873d', 'b5c94100')).toEqual({ error: 'Checksum failed. Try again' });
  });
});

describe('Dana persisted state', () => {
  it('drops malformed values', () => {
    expect(parsePersisted('{"pairingKey":"zz","ble5Keys":"363636383636","historyFrom":"x","bleId":""}')).toEqual({ ble5Keys: '363636383636' });
    expect(parsePersisted('not json')).toEqual({});
    expect(parsePersisted(null)).toEqual({});
  });
});
