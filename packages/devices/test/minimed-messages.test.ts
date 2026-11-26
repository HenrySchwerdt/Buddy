/**
 * MiniMed message layer against the vectors of MinimedKitTests (MinimedKit, migrated from
 * ps2/rileylink_ios, MIT License, (c) LoopKit Authors): 4b/6b, CRCs, packets, message bodies,
 * basal profile and pump model tables.
 */
import { describe, expect, it } from 'vitest';
import { fromHex, hex } from '@buddy/core';
import { crc8 } from '../src/minimed/radio/crc8';
import { decode4b6b, encode4b6b } from '../src/minimed/radio/four-b-six-b';
import { decodeMinimedPacket, encodeMinimedPacket } from '../src/minimed/radio/packet';
import { computeCrc16, checkCrc16 } from '../src/minimed/history/crc16';
import { MessageType, PacketType } from '../src/minimed/messages/message-type';
import { bolusBody, changeTempBasalBody, changeTimeBody, decodeBody, getHistoryPageBody, powerOnBody, suspendResumeBody, unitsRemaining } from '../src/minimed/messages/bodies';
import { carelinkMessage, decodePumpMessage, encodePumpMessage, pumpAddress } from '../src/minimed/messages/pump-message';
import { basalRateAt, decodeBasalSchedule, encodeBasalSchedule } from '../src/minimed/basal-schedule';
import {
  appendsSquareWaveOnStart,
  batteryPercentFromVolts,
  bolusDeliveryTimeMs,
  estimateBolusProgress,
  hasMySentry,
  insulinBitPackingScale,
  isLargerModel,
  reservoirCapacity,
  roundToSupportedBasalRate,
  roundToSupportedBolusVolume,
  supportedBasalRates,
  supportedBolusVolumes,
} from '../src/minimed/models';

const msg = (hexString: string) => decodePumpMessage(fromHex(hexString));
/** a Carelink message is 5 header bytes and a 65 byte body: pads the expected hex with zeros */
const pad70 = (prefix: string) => prefix + '00'.repeat(70 - prefix.length / 2);
const tx = (type: number, body: ReturnType<typeof bolusBody>) => hex(encodePumpMessage(carelinkMessage(fromHex('123456'), type, body)));

describe('MiniMed radio layer', () => {
  const decoded = 'a259705504a24117043a0e080b003d3d00015b030105d817790a0f00000300008b1702000e080b0000';
  const encoded = 'ab2959595965574ab2d31c565748ea54e55a54b5558cd8cd55557194b56357156535ac5659956a55c55555556355555568bc5657255554e55a54b5555555b1555000';

  it('decodes a 4b/6b packet and checks its CRC', () => {
    const input = fromHex('ab2959595965574ab2d31c565748ea54e55a54b5558cd8cd55557194b56357156535ac5659956a55c55555556355555568bc5657255554e55a54b5555555b100');
    expect(hex(decodeMinimedPacket(input)!)).toBe(decoded);
  });

  it('encodes a packet with its CRC-8 and the closing zero', () => {
    // the Swift vector feeds the message with its CRC (0x71) already appended; the packet appends the CRC of that again
    expect(hex(encodeMinimedPacket(fromHex(decoded + '71')))).toBe(encoded);
    expect(hex(encodeMinimedPacket(fromHex(decoded)))).toBe('ab2959595965574ab2d31c565748ea54e55a54b5558cd8cd55557194b56357156535ac5659956a55c55555556355555568bc5657255554e55a54b5555555b100');
  });

  it('rejects garbage, a wrong CRC and an empty packet', () => {
    expect(decodeMinimedPacket(fromHex('0102030405'))).toBeNull();
    expect(decodeMinimedPacket(encode4b6b(fromHex(decoded)))).toBeNull(); // no CRC appended
    expect(decodeMinimedPacket(new Uint8Array(0))).toBeNull();
  });

  it('round-trips arbitrary bytes through 4b/6b', () => {
    const data = Uint8Array.from({ length: 70 }, (_, i) => (i * 37 + 11) & 0xff);
    expect(decode4b6b(Uint8Array.from([...encode4b6b(data), 0]))).toEqual(data);
  });

  it('computes the CRC-8 of the Swift test', () => {
    expect(crc8(fromHex(decoded))).toBe(0x71);
  });

  it('computes and checks the page CRC-16', () => {
    const body = Uint8Array.from({ length: 1022 }, (_, i) => i & 0xff);
    const crc = computeCrc16(body);
    const page = Uint8Array.from([...body, crc >> 8, crc & 0xff]);
    expect(checkCrc16(page)).toBe(true);
    page[10] = page[10]! ^ 1;
    expect(checkCrc16(page)).toBe(false);
  });
});

describe('MiniMed command bodies (sent)', () => {
  it('encodes boluses like MinimedKit for 40 stroke pumps', () => {
    expect(tx(MessageType.bolus, bolusBody(1.1, 40))).toBe(pad70('a71234564202002c'));
    expect(tx(MessageType.bolus, bolusBody(1.475, 40))).toBe(pad70('a71234564202003a')); // 0.05 U steps above 1 U: 1.45
    expect(tx(MessageType.bolus, bolusBody(7.9, 40))).toBe(pad70('a71234564202013c'));
    expect(tx(MessageType.bolus, bolusBody(10.25, 40))).toBe(pad70('a712345642020198')); // 0.1 U steps above 10 U
  });

  it('encodes a bolus for 10 stroke pumps', () => {
    expect(tx(MessageType.bolus, bolusBody(1.1, 10))).toBe(pad70('a712345642010b'));
  });

  it('does not lose a stroke to floating point noise (0.35 U = 14 strokes)', () => {
    expect(tx(MessageType.bolus, bolusBody(0.35, 40))).toBe(pad70('a71234564202000e'));
  });

  it('encodes temp basals in strokes and 30 minute segments', () => {
    expect(tx(MessageType.changeTempBasal, changeTempBasalBody(1.1, 30 * 60_000))).toBe(pad70('a71234564c03002c01'));
    expect(tx(MessageType.changeTempBasal, changeTempBasalBody(6.5, 150 * 60_000))).toBe(pad70('a71234564c03010405'));
    expect(tx(MessageType.changeTempBasal, changeTempBasalBody(1.442, 65.5 * 60_000))).toBe(pad70('a71234564c03003902'));
  });

  it('cancels with 0 U/h for 0 minutes', () => {
    expect(tx(MessageType.changeTempBasal, changeTempBasalBody(0, 0))).toBe(pad70('a71234564c03000000'));
  });

  it('encodes the change time message', () => {
    const body = changeTimeBody({ year: 2017, month: 12, day: 29, hour: 9, minute: 22, second: 59 })!;
    expect(tx(MessageType.changeTime, body)).toBe(pad70('a71234564007' + '09163b07e10c1d'));
    expect(changeTimeBody({ year: 2017, month: 2, day: 30, hour: 9, minute: 22, second: 59 })).toBeNull();
  });

  it('encodes power on, suspend / resume and history page requests as 65 byte bodies', () => {
    expect(hex(powerOnBody(60_000).txData).slice(0, 6)).toBe('020101');
    expect(powerOnBody(61_000).txData[2]).toBe(2); // rounded up to whole minutes
    expect(hex(suspendResumeBody('suspend').txData).slice(0, 6)).toBe('010100');
    expect(hex(suspendResumeBody('resume').txData).slice(0, 6)).toBe('010000');
    expect(suspendResumeBody('suspend').txData).toHaveLength(65);
    expect(hex(getHistoryPageBody(3).txData).slice(0, 6)).toBe('010300');
  });

  it('addresses the pump by its 6 digit serial', () => {
    expect(hex(pumpAddress('636781')!)).toBe('636781');
    expect(pumpAddress('12345')).toBeNull();
    expect(pumpAddress('12345a')).toBeNull();
  });
});

describe('MiniMed answers (received)', () => {
  it('reads a temp basal', () => {
    const m = msg('a7123456980600000037001700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(m.body).toMatchObject({ kind: 'tempBasal', rateType: 'absolute', rate: 1.375, timeRemainingMin: 23 });
    const high = msg('a7754838980600000550001e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(high.body).toMatchObject({ rate: 34, timeRemainingMin: 30 });
    const zero = msg('a7123456980600000000001d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(zero.body).toMatchObject({ rate: 0, timeRemainingMin: 29 });
  });

  it('reads the settings of an x22 / x23 pump', () => {
    const x22 = msg('a7594040c01900010001010096008c00000000000064010400140019010101000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(x22.body).toMatchObject({ kind: 'settings', maxBasal: 3.5, maxBolus: 15, selectedBasalProfile: 'standard', insulinActionCurveHours: 4 });
    const x23 = msg('a7754838c0150003010100e505500000000000000164000400140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(x23.body).toMatchObject({ maxBasal: 34, maxBolus: 22.9, insulinActionCurveHours: 4 });
  });

  it('reads battery, model and reservoir', () => {
    const battery = msg('a7350535720300008c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(battery.body).toMatchObject({ kind: 'battery', status: 'normal', volts: 1.4 });
    const model = msg('a73505358d0903353233000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(model.body).toMatchObject({ kind: 'pumpModel', model: '523' });
    const r723 = msg('a7594040730400000ca3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    const r522 = msg('a7578398730205460000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')!;
    expect(unitsRemaining((r723.body as { raw: Uint8Array }).raw, insulinBitPackingScale('723'))).toBe(80.875);
    expect(unitsRemaining((r522.body as { raw: Uint8Array }).raw, insulinBitPackingScale('522'))).toBe(135);
  });

  it('knows pump errors and acks', () => {
    expect(msg('a7123456150c')!.body).toMatchObject({ kind: 'error', code: 0x0c });
    expect(msg('a712345606' + '00')!.body).toMatchObject({ kind: 'ack' });
  });

  it('rejects short, foreign and unknown messages', () => {
    expect(msg('a712345698')).toBeNull(); // no body
    expect(msg('a5123456980600')).toBeNull(); // meter packets are not for us
    expect(msg('a7123456ff00')).toBeNull(); // unknown message type
    expect(decodeBody(MessageType.getBattery, new Uint8Array(10))).toBeNull(); // wrong length
  });

  it('encodes what it decodes (round trip)', () => {
    const raw = fromHex('a712345606' + '00');
    expect(hex(encodePumpMessage(decodePumpMessage(raw)!))).toBe(hex(raw));
    expect(decodePumpMessage(raw)!.packetType).toBe(PacketType.carelink);
  });
});

describe('MiniMed basal schedule', () => {
  const sample =
    '06000052000178050202000304000402000504000602000704000802000904000a02000b04000c02000d02000e02000f040010020011040012020013040014020015040016020017040018020019' + '00'.repeat(192 - 78);

  it('decodes the pump profile', () => {
    const s = decodeBasalSchedule(fromHex(sample))!;
    expect(s.entries).toHaveLength(26);
    expect(s.entries[0]).toEqual({ index: 0, startMinute: 0, rate: 0.15 });
    expect(s.entries[1]).toEqual({ index: 1, startMinute: 30, rate: 2.05 });
    expect(s.entries[2]).toEqual({ index: 2, startMinute: 60, rate: 35 });
    expect(s.entries[25]).toEqual({ index: 25, startMinute: 750, rate: 0.05 });
    expect(hex(encodeBasalSchedule(s))).toBe(sample);
    expect(basalRateAt(s, 45)).toBe(2.05);
  });

  it('encodes a schedule and the empty "clear" code', () => {
    const s = { entries: [{ index: 0, startMinute: 0, rate: 1 }, { index: 1, startMinute: 240, rate: 2 }] };
    expect(hex(encodeBasalSchedule(s)).slice(0, 12)).toBe('280000500008');
    expect(decodeBasalSchedule(encodeBasalSchedule({ entries: [] }))).toBeNull();
    expect(encodeBasalSchedule({ entries: [] })[2]).toBe(0x3f);
  });
});

describe('MiniMed pump models', () => {
  it('knows the generation specific properties', () => {
    expect(isLargerModel('523')).toBe(true);
    expect(isLargerModel('522')).toBe(false);
    expect(appendsSquareWaveOnStart('523')).toBe(true);
    expect(appendsSquareWaveOnStart('522')).toBe(false);
    expect(hasMySentry('723')).toBe(true);
    expect(insulinBitPackingScale('754')).toBe(40);
    expect(insulinBitPackingScale('515')).toBe(10);
    expect(reservoirCapacity('522')).toBe(176);
    expect(reservoirCapacity('722')).toBe(300);
  });

  it('lists the deliverable rates and volumes', () => {
    const r = supportedBasalRates('723');
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(0.025);
    expect(r).toContain(0.975);
    expect(r).toContain(1.05);
    expect(r).toContain(10.1);
    expect(r[r.length - 1]).toBe(35);
    expect(supportedBasalRates('522')[1]).toBe(0.05);
    const v = supportedBolusVolumes('723');
    expect(v[0]).toBe(0.025);
    expect(v).toContain(1.05);
    expect(v).toContain(10.1);
    expect(v[v.length - 1]).toBe(25);
    expect(supportedBolusVolumes('522')[0]).toBe(0.1);
  });

  it('rounds down to a supported step, never up', () => {
    expect(roundToSupportedBasalRate('723', 1.07)).toBe(1.05);
    expect(roundToSupportedBasalRate('723', 0.30000000000000004)).toBe(0.3);
    expect(roundToSupportedBasalRate('522', 0.07)).toBe(0.05);
    expect(roundToSupportedBasalRate('723', 0.01)).toBe(0);
    expect(roundToSupportedBolusVolume('723', 1.49)).toBe(1.45);
    expect(roundToSupportedBolusVolume('723', 0.5)).toBe(0.5);
    expect(roundToSupportedBolusVolume('522', 0.19)).toBe(0.1);
    expect(roundToSupportedBolusVolume('522', 0.05)).toBe(0);
    expect(roundToSupportedBolusVolume('723', 99)).toBe(25);
  });

  it('delivers boluses at the pump speed', () => {
    expect(bolusDeliveryTimeMs('723', 0.5)).toBe((0.5 / 0.75) * 60_000);
    expect(bolusDeliveryTimeMs('723', 3)).toBe(2 * 60_000);
    expect(bolusDeliveryTimeMs('723', 10)).toBe(5 * 60_000);
    expect(bolusDeliveryTimeMs('522', 3)).toBe(2 * 60_000);
    expect(estimateBolusProgress('723', 0, 2).deliveredUnits).toBe(0);
    expect(estimateBolusProgress('723', 60_000, 3).deliveredUnits).toBe(1.5);
    expect(estimateBolusProgress('723', 10 * 60_000, 3).deliveredUnits).toBe(3);
    expect(estimateBolusProgress('723', 5 * 60_000, 7.9).deliveredUnits).toBe(7.9);
  });

  it('estimates the battery from the cell voltage', () => {
    expect(batteryPercentFromVolts(1.47)).toBe(100);
    expect(batteryPercentFromVolts(1.18)).toBe(0);
    expect(batteryPercentFromVolts(1.0)).toBe(0);
    expect(batteryPercentFromVolts(1.4)).toBe(76);
    expect(batteryPercentFromVolts(1.32, 'lithium')).toBe(0);
  });
});
