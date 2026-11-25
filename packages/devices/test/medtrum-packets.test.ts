/**
 * Port of the MedtrumKitTests packet / crypto / basal schedule tests from loopandlearn/MedtrumKit
 * (MIT License, (c) the original MedtrumKit authors), with the same byte vectors.
 */
import { describe, expect, it } from 'vitest';
import { basalScheduleToBytes } from '../src/medtrum/basal-schedule';
import { genKey, simpleDecrypt } from '../src/medtrum/crypto';
import { crc8 } from '../src/medtrum/crc8';
import { AlarmSettings, BasalType, PatchState } from '../src/medtrum/enums';
import { emptySyncResponse, NotificationPacket, SynchronizePacket, validated } from '../src/medtrum/notification-packet';
import {
  ActivatePacket,
  AuthorizePacket,
  CancelBolusPacket,
  CancelTempBasalPacket,
  GetTimePacket,
  PrimePacket,
  ResumePumpPacket,
  SetBasalProfilePacket,
  SetBolusPacket,
  SetPatchPacket,
  SetTempBasalPacket,
  SetTimePacket,
  SetTimeZonePacket,
  StopPatchPacket,
  SubscribePacket,
  SuspendPumpPacket,
} from '../src/medtrum/packets';

const D = (...b: number[]) => new Uint8Array(b);
const secs = (unix: number) => unix * 1000;

describe('Medtrum CryptoTests', () => {
  it('testKeyGen', () => {
    // 2859923929 -> 3364239851
    expect(genKey(D(217, 249, 118, 170))).toEqual(D(235, 57, 134, 200));
  });
  it('testKeyDecrypt', () => {
    // 2859923929 -> 126009121
    expect(simpleDecrypt(D(217, 249, 118, 170))).toEqual(D(33, 191, 130, 7));
  });
});

describe('Medtrum BasalScheduleTests', () => {
  it('testScheduleToData', () => {
    const input = [
      { startMinute: 0, value: 2.1 },
      { startMinute: 4 * 60, value: 1.9 },
      { startMinute: 6 * 60, value: 1.7 },
      { startMinute: 8 * 60, value: 1.5 },
      { startMinute: 16 * 60, value: 1.6 },
      { startMinute: 21 * 60, value: 1.7 },
      { startMinute: 23 * 60, value: 2 },
    ];
    expect(basalScheduleToBytes(input)).toEqual(D(7, 0, 160, 2, 240, 96, 2, 104, 33, 2, 224, 225, 1, 192, 3, 2, 236, 36, 2, 100, 133, 2));
  });
});

const single = (packet: { encode(seq: number): Uint8Array[] }, expected: Uint8Array) => {
  const actual = packet.encode(0);
  expect(actual).toHaveLength(1);
  expect(actual[0]).toEqual(expected);
};

describe('Medtrum request encoding (MedtrumKitTests vectors)', () => {
  it('SubscribePacket', () => single(new SubscribePacket(), D(7, 4, 0, 0, 255, 15, 163, 0)));
  it('CancelBolusPacket', () => single(new CancelBolusPacket(), D(6, 20, 0, 0, 1, 16, 0)));
  it('CancelTempBasalPacket', () => single(new CancelTempBasalPacket(), D(5, 25, 0, 0, 167, 0)));
  it('ResumePumpPacket', () => single(new ResumePumpPacket(), D(5, 29, 0, 0, 68, 0)));
  it('PrimePacket', () => single(new PrimePacket(), D(5, 16, 0, 0, 164, 0)));
  it('SynchronizePacket', () => single(new SynchronizePacket(), D(5, 3, 0, 0, 252, 0)));
  it('StopPatchPacket', () => single(new StopPatchPacket(), D(5, 31, 0, 0, 248, 0)));
  it('GetTimePacket', () => single(new GetTimePacket(), D(5, 11, 0, 0, 161, 0)));
  it('SetBolusPacket 1.40 U', () => single(new SetBolusPacket(1.4), D(9, 19, 0, 0, 1, 28, 0, 0, 253, 0)));
  it('SetTempBasalPacket 1.25 U/h for 1 h', () => single(new SetTempBasalPacket(1.25, 60), D(10, 24, 0, 0, 6, 25, 0, 60, 0, 59, 0)));
  it('SetTimePacket', () => single(new SetTimePacket(secs(1_741_721_000)), D(10, 10, 0, 0, 2, 40, 51, 13, 21, 26, 0)));
  it('SetTimeZonePacket CET', () => single(new SetTimeZonePacket(secs(1_741_721_000), 3600), D(11, 12, 0, 0, 60, 0, 40, 51, 13, 21, 110, 0)));
  it('SetTimeZonePacket UTC+13 (wraps to -11 h)', () =>
    // [108, 253] -> 64876
    single(new SetTimeZonePacket(secs(1_741_721_000), 13 * 3600), D(11, 12, 0, 0, 108, 253, 40, 51, 13, 21, 120, 0)));
  it('SetBasalProfilePacket', () =>
    single(new SetBasalProfilePacket(D(3, 16, 14, 0, 0, 1, 2, 12, 12, 12)), D(16, 21, 0, 0, 1, 3, 16, 14, 0, 0, 1, 2, 12, 12, 12, 67, 0)));
  it('SetPatchPacket', () =>
    single(
      new SetPatchPacket({ alarmSettings: AlarmSettings.LightAndVibrate, hourlyMaxInsulin: 40, dailyMaxInsulin: 180, expirationTimer: 0 }),
      D(16, 35, 0, 0, 1, 32, 3, 16, 14, 0, 0, 12, 0, 0, 30, 46, 0),
    ));
  it('AuthorizePacket (MedtrumBasePacketTests / AuthorizePacketTests)', () =>
    // pumpSN as stored by MedtrumPumpState (the packet reverses it, exactly like the Swift original)
    single(new AuthorizePacket(D(217, 249, 118, 170), D(155, 2, 0, 0)), D(14, 5, 0, 0, 2, 155, 2, 0, 0, 72, 205, 18, 8, 36, 0)));

  it('ActivatePacket splits into three packets', () => {
    const input = new ActivatePacket({
      expirationTimer: 0,
      alarmSetting: AlarmSettings.LightOnly,
      hourlyMaxInsulin: 40,
      dailyMaxInsulin: 180,
      currentTDD: 0,
      basalProfile: D(7, 0, 160, 2, 240, 96, 2, 104, 33, 2, 224, 225, 1, 192, 3, 2, 236, 36, 2, 100, 133, 2),
    });
    const actual = input.encode(0);
    expect(actual).toEqual([
      D(41, 18, 0, 1, 0, 12, 0, 3, 0, 0, 30, 32, 3, 16, 14, 0, 0, 1, 7, 173),
      D(41, 18, 0, 2, 0, 160, 2, 240, 96, 2, 104, 33, 2, 224, 225, 1, 192, 3, 2, 253),
      D(41, 18, 0, 3, 236, 36, 2, 100, 133, 2, 144, 163),
    ]);
  });

  it('ActivatePacket splits into two packets', () => {
    const input = new ActivatePacket({
      expirationTimer: 1,
      alarmSetting: AlarmSettings.BeepOnly,
      hourlyMaxInsulin: 40,
      dailyMaxInsulin: 180,
      currentTDD: 0,
      basalProfile: D(3, 16, 14, 0, 0, 1, 2, 12, 12, 12),
    });
    expect(input.encode(0)).toEqual([
      D(29, 18, 0, 1, 0, 12, 1, 6, 0, 0, 30, 32, 3, 16, 14, 0, 0, 1, 3, 150),
      D(29, 18, 0, 2, 16, 14, 0, 0, 1, 2, 12, 12, 12, 217, 9),
    ]);
  });

  it('never rounds a bolus up (deviation from Swift round())', () => {
    // 1.43 U would be round(28.6) = 29 steps = 1.45 U in Swift; Buddy floors to 28 steps = 1.40 U
    expect(new SetBolusPacket(1.43).getRequestBytes()).toEqual(D(1, 28, 0, 0));
    expect(new SetTempBasalPacket(0.07, 30).getRequestBytes()).toEqual(D(6, 1, 0, 30, 0));
  });

  it('SuspendPumpPacket rejects durations that do not fit a byte', () => {
    expect(new SuspendPumpPacket(120).getRequestBytes()).toEqual(D(3, 120));
    expect(() => new SuspendPumpPacket(256).getRequestBytes()).toThrow();
  });
});

describe('Medtrum response decoding (MedtrumKitTests vectors)', () => {
  const basalCases = [
    ['CancelTempBasalPacket', () => new CancelTempBasalPacket(), D(17, 25, 16, 0, 0, 0, 1, 22, 0, 3, 0, 146, 0, 224, 238, 88, 17, 52), BasalType.STANDARD, 1.1, 3],
    ['SetBasalProfilePacket', () => new SetBasalProfilePacket(D(3, 16, 14, 0, 0, 1, 2, 12, 12, 12)), D(17, 21, 16, 0, 0, 0, 1, 22, 0, 3, 0, 146, 0, 224, 238, 88, 17, 44), BasalType.STANDARD, 1.1, 3],
    ['SetTempBasalPacket', () => new SetTempBasalPacket(1.25, 60), D(17, 24, 12, 0, 0, 0, 6, 25, 0, 2, 0, 146, 0, 224, 238, 88, 17, 217), BasalType.ABSOLUTE_TEMP, 1.25, 2],
  ] as const;

  for (const [name, make, response, type, value, seq] of basalCases) {
    it(`${name} response`, () => {
      const packet = make();
      packet.decode(response);
      expect(packet.failed).toBe(false);
      expect(packet.isComplete).toBe(true);
      expect(packet.hasEnoughData).toBe(true);
      const actual = packet.parseResponse();
      expect(actual.basalType).toBe(type);
      expect(actual.basalValue).toBe(value);
      expect(actual.basalSequence).toBe(seq);
      expect(actual.basalPatchId).toBe(146);
      expect(actual.basalStartTime).toBe(secs(1_679_575_392));
    });
    it(`${name} response too short fails`, () => {
      const packet = make();
      packet.decode(response.subarray(0, response.length - 1));
      expect(packet.failed).toBe(true);
    });
  }

  it('AuthorizePacket response', () => {
    const packet = new AuthorizePacket(D(217, 249, 118, 170), D(155, 2, 0, 0));
    packet.decode(D(11, 5, 0, 0, 0, 0, 0, 80, 12, 1, 3, 96));
    expect(packet.failed).toBe(false);
    expect(packet.isComplete).toBe(true);
    expect(packet.hasEnoughData).toBe(true);
    expect(packet.parseResponse()).toEqual({ deviceType: 80, swVersion: '12.1.3' });
  });

  it('AuthorizePacket response too short fails', () => {
    const packet = new AuthorizePacket(D(217, 249, 118, 170), D(155, 2, 0, 0));
    packet.decode(D(11, 5, 0, 0, 0, 0, 0, 80, 12, 1, 3));
    expect(packet.failed).toBe(true);
  });

  it('GetTimePacket response', () => {
    const packet = new GetTimePacket();
    packet.decode(D(10, 11, 0, 0, 0, 0, 224, 238, 88, 17, 137));
    expect(packet.failed).toBe(false);
    expect(packet.isComplete).toBe(true);
    expect(packet.hasEnoughData).toBe(true);
    expect(packet.parseResponse().time).toBe(secs(1_679_575_392));
  });

  it('GetTimePacket response too short fails', () => {
    const packet = new GetTimePacket();
    packet.decode(D(10, 11, 0, 0, 0, 0, 224, 238, 88, 17));
    expect(packet.failed).toBe(true);
  });

  const activate = () =>
    new ActivatePacket({
      expirationTimer: 1,
      alarmSetting: AlarmSettings.BeepOnly,
      hourlyMaxInsulin: 40,
      dailyMaxInsulin: 180,
      currentTDD: 0,
      basalProfile: D(3, 16, 14, 0, 0, 1, 2, 12, 12, 12),
    });

  it('ActivatePacket response', () => {
    const packet = activate();
    packet.decode(D(26, 18, 19, 1, 0, 0, 41, 0, 0, 0, 152, 91, 28, 17, 1, 30, 0, 1, 0, 41, 0, 224, 238, 88, 17, 184, 0));
    expect(packet.failed).toBe(false);
    expect(packet.isComplete).toBe(true);
    expect(packet.hasEnoughData).toBe(true);
    const actual = packet.parseResponse();
    expect(actual.patchId).toEqual(D(41, 0, 0, 0));
    expect(actual.time).toBe(secs(1_675_605_528));
    expect(actual.basalType).toBe(BasalType.STANDARD);
    expect(actual.basalValue).toBe(1.5);
    expect(actual.basalSequence).toBe(1);
    expect(actual.basalPatchId).toBe(41);
    expect(actual.basalStartTime).toBe(secs(1_679_575_392));
  });

  it('ActivatePacket response too short fails', () => {
    const packet = activate();
    packet.decode(D(26, 18, 19, 1, 0, 0, 41, 0, 0, 0, 152, 91, 28, 17, 1, 30, 0, 1, 0, 41, 0, 152, 91, 28, 17));
    expect(packet.failed).toBe(true);
  });
});

const SYNC_RESPONSE = [
  0, 3, 0, 0, 0, 0, 1, 206, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
];

describe('Medtrum SynchronizePacketTests', () => {
  it('testResponseGivenPacketWhenValuesSetThenReturnCorrectValues', () => {
    const packet = new SynchronizePacket();
    packet.decode(D(...SYNC_RESPONSE, 233));
    expect(packet.failed).toBe(false);
    expect(packet.parseResponse().state).toBe(PatchState.idle);
  });

  it('testResponseGivenSplittedPacketsWhenValuesSetThenReturnCorrectValues', () => {
    const packet = new SynchronizePacket();
    packet.decode(D(23, 3, 4, 1, 0, 0, 2, 160, 5, 59, 15, 132, 59, 90, 1, 0, 50, 0, 110, 48));
    packet.decode(D(23, 3, 4, 2, 6, 0, 0, 182, 224));
    expect(packet.failed).toBe(false);
    expect(packet.isComplete).toBe(true);
    expect(packet.hasEnoughData).toBe(true);
    expect(packet.parseResponse().state).toBe(PatchState.filled);
  });

  it('testResponseGivenResponseWhenMessageTooShortThenResultFalse', () => {
    const packet = new SynchronizePacket();
    packet.decode(D(...SYNC_RESPONSE));
    expect(packet.failed).toBe(true);
  });

  it('testResponseContainingSyncDataThenDataSaved', () => {
    const packet = new SynchronizePacket();
    packet.decode(
      D(47, 3, 3, 1, 0, 0, 32, 238, 13, 128, 5, 0, 128, 0, 0, 6, 25, 0, 14, 0, 84, 163, 173, 17, 17, 64, 0, 152, 14, 248, 137, 173, 17, 240, 11, 90, 26, 0, 14, 0, 187, 31, 0, 0, 140, 14, 200, 242),
    );
    expect(packet.failed).toBe(false);
    const actual = packet.parseResponse();
    expect(actual.state).toBe(PatchState.active);
    expect(actual.basal?.type).toBe(BasalType.ABSOLUTE_TEMP);
    expect(actual.basal!.rate).toBeCloseTo(0.85, 2);
    expect(actual.basal?.sequence).toBe(25);
    expect(actual.basal?.patchId).toBe(14);
    expect(actual.basal?.startTime).toBe(secs(1_685_126_612));
    expect(actual.patchAge).toBe(8123);
    expect(actual.startTime).toBe(secs(1_685_120_120));
    expect(actual.battery).toBeDefined();
    expect(actual.battery!.voltageA).toBeCloseTo(5.96875, 2);
    expect(actual.battery!.voltageB).toBeCloseTo(2.8125, 2);
  });
});

const notification = (...bytes: number[]) => {
  const p = new NotificationPacket();
  p.totalData = D(...bytes);
  return p;
};

describe('Medtrum NotificationPacketTests', () => {
  it('testBasalDataProvided', () => {
    const actual = notification(32, 40, 64, 6, 25, 0, 14, 0, 84, 163, 173, 17, 17, 64, 0, 152, 14, 0, 16).parseResponse();
    expect(actual.state).toBe(PatchState.active);
    expect(actual.basal?.type).toBe(BasalType.ABSOLUTE_TEMP);
    expect(actual.basal?.rate ?? 0).toBeCloseTo(0.85, 2);
    expect(actual.basal?.sequence).toBe(25);
    expect(actual.basal?.startTime).toBe(secs(1_685_126_612));
    expect(actual.reservoir ?? 0).toBeCloseTo(186.8, 2);
  });

  it('testSequenceDataProvided', () => {
    const actual = notification(32, 0, 17, 167, 0, 14, 0, 0, 0, 0, 0, 0).parseResponse();
    expect(actual.state).toBe(PatchState.active);
    expect(actual.storage?.sequence).toBe(167);
  });

  it('testTruncatedPayloadKeepsOnlyTheState', () => {
    // state 98 (reservoir empty), mask announces reservoir + storage + alarm, but the payload
    // stops halfway through the storage field - see issue #194
    const actual = notification(98, 0x20, 0x03, 20, 0, 167, 0).parseResponse();
    expect(actual.state).toBe(PatchState.reservoirEmpty);
    expect(actual.truncated).toBe(true);
    expect(actual.reservoir).toBeUndefined();
    expect(actual.storage).toBeUndefined();
    expect(actual.activeAlarms).toHaveLength(0);
  });

  it('testNotificationWithoutFieldsIsNotTruncated', () => {
    const actual = notification(98, 0, 0).parseResponse();
    expect(actual.state).toBe(PatchState.reservoirEmpty);
    expect(actual.truncated).toBe(false);
  });

  it('testNotificationShorterThanTheHeader', () => {
    const packet = notification(98, 0x20);
    expect(packet.hasEnoughData).toBe(true);
    const actual = packet.parseResponse();
    expect(actual.state).toBe(PatchState.reservoirEmpty);
    expect(actual.truncated).toBe(true);
  });

  it('testBolusProgress', () => {
    const actual = notification(32, 34, 16, 0, 3, 0, 198, 12, 0, 0, 0, 0, 0).parseResponse();
    expect(actual.state).toBe(PatchState.active);
    expect(actual.bolus?.completed).toBe(false);
    expect(actual.bolus?.delivered ?? 0).toBeCloseTo(0.15, 2);
    expect(actual.reservoir ?? 0).toBeCloseTo(163.5, 2);
  });

  it('testStateOnlyNotification', () => {
    const packet = notification(98);
    expect(packet.hasEnoughData).toBe(true);
    const r = packet.parseResponse();
    expect(r.state).toBe(PatchState.reservoirEmpty);
    expect(r.truncated).toBe(false);
  });

  it('testEmptyNotificationIsRejectedWithoutTrapping', () => {
    const packet = new NotificationPacket();
    expect(packet.hasEnoughData).toBe(false);
    expect(packet.parseResponse().truncated).toBe(true);
  });

  it('testOutOfRangeFieldDiscardsEntirePayloadButKeepsState', () => {
    // Each packet also contains a valid field, which must be discarded together with the bad one.
    const payloads = [
      [98, 0x22, 0, 0, 0xe9, 3, 20, 0], // bolus 50.05 U, valid reservoir
      [98, 0x28, 0, 6, 1, 0, 14, 0, 0, 0, 0, 0, 0x21, 3, 0, 20, 0], // basal 40.05 U/h
      [98, 0x22, 0, 0, 3, 0, 0x41, 0x1f], // valid bolus, reservoir 400.05 U
    ];
    for (const payload of payloads) {
      const r = notification(...payload).parseResponse();
      expect(r.state).toBe(PatchState.reservoirEmpty);
      expect(r.invalidPayload).toBe(true);
      expect(r.truncated).toBe(false);
      expect(r.bolus).toBeUndefined();
      expect(r.basal).toBeUndefined();
      expect(r.reservoir).toBeUndefined();
    }
  });

  it('testValidationAcceptsBoundaryValues', () => {
    const r = validated(
      emptySyncResponse(PatchState.active, {
        bolus: { type: 0, completed: true, delivered: 50 },
        basal: { type: BasalType.ABSOLUTE_TEMP, sequence: 1, patchId: 14, startTime: Date.now(), rate: 40, delivery: 0 },
        reservoir: 400,
        storage: { sequence: 1, patchId: 14 },
      }),
      14,
    );
    expect(r.invalidPayload).toBe(false);
    expect(r.reservoir).toBe(400);
    expect(r.basal?.rate).toBe(40);
    expect(r.bolus?.delivered).toBe(50);
  });

  it('testMismatchedPatchDiscardsAllFields', () => {
    for (const basalPatch of [14, 15]) {
      const response = emptySyncResponse(PatchState.reservoirEmpty, {
        basal: { type: BasalType.ABSOLUTE_TEMP, sequence: 1, patchId: basalPatch, startTime: Date.now(), rate: 2, delivery: 0 },
        reservoir: 20,
        storage: { sequence: 1, patchId: basalPatch === 14 ? 15 : 14 },
      });
      const rejected = validated(response, 14);
      expect(rejected.invalidPayload).toBe(true);
      expect(rejected.state).toBe(PatchState.reservoirEmpty);
      expect(rejected.basal).toBeUndefined();
      expect(rejected.storage).toBeUndefined();
      expect(rejected.reservoir).toBeUndefined();
      expect(validated(response).invalidPayload).toBe(false); // No known patch yet during setup.
    }
  });
});

describe('Medtrum framing', () => {
  it('a multi-fragment response carries an inner CRC over header + body (simulator relies on this)', () => {
    // From testResponseGivenSplittedPackets: inner byte 182 is crc8 of the reassembled message
    const header = D(23, 3, 4, 0);
    const body = D(0, 0, 2, 160, 5, 59, 15, 132, 59, 90, 1, 0, 50, 0, 110, 6, 0, 0);
    const full = new Uint8Array([...header, ...body]);
    expect(crc8(full)).toBe(182);
  });
});
