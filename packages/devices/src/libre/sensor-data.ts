/**
 * TypeScript port of `LibreSensor/SensorContents/SensorData.swift` and
 * `LibreSensor/SensorContents/SensorSerialNumber.swift` from loopandlearn/LibreTransmitter
 * (MIT, (c) Uwe Petersen and the LibreTransmitter authors).
 *
 * 344-byte FRAM layout: header 0..23 (3 blocks), body 24..319 (37 blocks), footer 320..343
 * (3 blocks). Each section starts with a big-endian CRC over the rest of the section.
 */
import type { Bytes } from '@buddy/core';
import { readBits } from './bits';
import type { CalibrationInfo } from './calibration';
import { byteSwap16, hasValidCrc16InFirstTwoBytes, libreCrc16 } from './crc';
import { decryptFram } from './libre2-crypto';
import { measurementFromBytes, roundHalfAwayFromZero, createMeasurement, type Measurement } from './measurement';
import { sensorFamilyFromRaw, sensorStateFromByte, sensorTypeFromPatchInfo, type SensorFamily, type SensorState } from './sensor-type';

export const FRAM_LENGTH = 344;
const MINUTE = 60_000;

const LOOKUP = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'] as const;

/** `SensorSerialNumber.serialNumber`: the printed serial (e.g. `3MH001GJ0VW`) from the 8-byte UID. */
export function sensorSerialNumber(uid: ArrayLike<number>, family: SensorFamily): string | null {
  if (uid.length !== 8) return null;
  const b = Array.from(uid).reverse().slice(2); // E0 07 A0 00 00 25 90 5E -> A0 00 00 25 90 5E
  const [b0, b1, b2, b3, b4, b5] = b as [number, number, number, number, number, number];
  const five = [b0 >> 3, (b0 << 2) + (b1 >> 6), b1 >> 1, (b1 << 4) + (b2 >> 4), (b2 << 1) + (b3 >> 7), b3 >> 2, (b3 << 3) + (b4 >> 5), b4, b5 >> 3, b5 << 2];
  return five.reduce((s, v) => s + LOOKUP[v & 0x1f], String(family));
}

export class SensorData {
  readonly uuid: Bytes;
  readonly bytes: Bytes;
  /** Read time rounded down to the minute (Swift: `date.rounded(on: 1, .minute)`). */
  readonly date: number;
  readonly patchInfo: Bytes | null;

  private constructor(uuid: Bytes, bytes: Bytes, date: number, patchInfo: Bytes | null) {
    this.uuid = uuid;
    this.bytes = bytes;
    this.date = date;
    this.patchInfo = patchInfo;
  }

  /** `SensorData(uuid:bytes:date:)`; returns null unless exactly 344 bytes are given. */
  static create(uuid: Bytes, bytes: Bytes, date: number, patchInfo: Bytes | null = null): SensorData | null {
    if (bytes.length !== FRAM_LENGTH) return null;
    return new SensorData(uuid.slice(), bytes.slice(), Math.floor(date / MINUTE) * MINUTE, patchInfo?.slice() ?? null);
  }

  withPatchInfo(patchInfo: Bytes): SensorData {
    return new SensorData(this.uuid, this.bytes, this.date, patchInfo.slice());
  }

  /** `mutating func decrypt(patchInfo:uid:)`: returns a decrypted copy, or `this` if the type is not decryptable. */
  decrypted(patchInfo: Bytes, uid: ArrayLike<number>): SensorData {
    try {
      return new SensorData(this.uuid, decryptFram(sensorTypeFromPatchInfo(patchInfo), uid, patchInfo, this.bytes), this.date, this.patchInfo);
    } catch {
      return this;
    }
  }

  get header(): Bytes { return this.bytes.subarray(0, 24); }
  get body(): Bytes { return this.bytes.subarray(24, 320); }
  get footer(): Bytes { return this.bytes.subarray(320, 344); }

  get minutesSinceStart(): number { return (this.body[293]! << 8) + this.body[292]!; }
  get maxMinutesWearTime(): number { return (this.footer[7]! << 8) + this.footer[6]!; }
  get minutesLeft(): number { return this.maxMinutesWearTime - this.minutesSinceStart; }
  get nextTrendBlock(): number { return this.body[2]!; }
  get nextHistoryBlock(): number { return this.body[3]!; }

  get hasValidHeaderCRC(): boolean { return hasValidCrc16InFirstTwoBytes(this.header); }
  get hasValidBodyCRC(): boolean { return hasValidCrc16InFirstTwoBytes(this.body); }
  get hasValidFooterCRC(): boolean { return hasValidCrc16InFirstTwoBytes(this.footer); }
  get hasValidCRCs(): boolean { return this.hasValidHeaderCRC && this.hasValidBodyCRC && this.hasValidFooterCRC; }

  get footerCrc(): number { return libreCrc16(this.footer.subarray(2), 0xffff); }
  get state(): SensorState { return sensorStateFromByte(this.header[4]!); }

  /** All Libre 1 and (decrypted) Libre 2 FRAMs have zeros in bytes 9..23. */
  get isLikelyLibre1FRAM(): boolean {
    return this.bytes.length > 23 && !this.bytes.subarray(9, 24).some((b) => b > 0);
  }

  get serialNumber(): string {
    if (!this.patchInfo || this.patchInfo.length < 6) return '-';
    const family = sensorFamilyFromRaw(this.patchInfo[2]! >> 4);
    if (family === null) return '-';
    return sensorSerialNumber(this.uuid, family) ?? '-';
  }

  /** `calibrationData`: factory calibration parameters read from the FRAM. */
  get calibrationData(): CalibrationInfo {
    const data = this.bytes;
    const i3 = readBits(data, 0x150, 0, 8);
    const negativeI3 = readBits(data, 0x150, 0x21, 1) !== 0;
    return {
      i1: readBits(data, 2, 0, 3),
      i2: readBits(data, 2, 3, 0xa),
      i3: negativeI3 ? -i3 : i3,
      i4: readBits(data, 0x150, 8, 0xe),
      i5: readBits(data, 0x150, 0x28, 0xc) << 2,
      i6: readBits(data, 0x150, 0x34, 0xc) << 2,
      extraSlope: 1,
      extraOffset: 0,
      isValidForFooterWithReverseCRCs: byteSwap16(this.footerCrc),
    };
  }

  private record(index: number): Bytes {
    if (index < 0 || index + 6 > this.body.length) throw new RangeError(`FRAM record index ${index} out of range`);
    return this.body.subarray(index, index + 6);
  }

  /** 16 one-minute trend values, most recent first (`trendMeasurements()`). */
  trendMeasurements(): Measurement[] {
    const out: Measurement[] = [];
    for (let blockIndex = 0; blockIndex <= 15; blockIndex++) {
      let index = 4 + (this.nextTrendBlock - 1 - blockIndex) * 6; // runs backwards
      if (index < 4) index += 96; // ring buffer wrap
      out.push(measurementFromBytes(this.record(index), this.date - MINUTE * blockIndex));
    }
    return out;
  }

  /** `dateOfMostRecentHistoryValue()`: date and minute counter of the newest 15-minute value. */
  dateOfMostRecentHistoryValue(): { date: number; counter: number } {
    const nextHistoryIndexFromCounter = Math.trunc((this.minutesSinceStart - 3) / 15) % 32;
    const delay = ((this.minutesSinceStart - 3) % 15) + 3;
    if (nextHistoryIndexFromCounter === this.nextHistoryBlock) {
      return { date: this.date - MINUTE * delay, counter: this.minutesSinceStart - delay };
    }
    // history index incremented before minutesSinceStart (out of sync)
    return { date: this.date - MINUTE * (delay - 15), counter: this.minutesSinceStart - delay };
  }

  /** 32 fifteen-minute history values, most recent first (`historyMeasurements()`). */
  historyMeasurements(): Measurement[] {
    const out: Measurement[] = [];
    const { date, counter } = this.dateOfMostRecentHistoryValue();
    for (let blockIndex = 0; blockIndex < 32; blockIndex++) {
      let index = 100 + (this.nextHistoryBlock - 1 - blockIndex) * 6;
      if (index < 100) index += 192;
      out.push(measurementFromBytes(this.record(index), date - 900_000 * blockIndex, counter - blockIndex * 15));
    }
    return out;
  }
}

const average = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * `[Measurement].predictBloodSugar(_:)`: linear regression over raw glucose, extrapolated
 * `minutes` into the future from the array's first element. Needs more than 15 values.
 */
export function predictBloodSugar(measurements: readonly Measurement[], minutes = 10): Measurement | null {
  const first = measurements[0];
  if (measurements.length <= 15) return first ?? null;
  if (!first) return null;
  const sorted = [...measurements].sort((a, b) => a.date - b.date);
  const futureDate = first.date + 60_000 * minutes;
  const xs = sorted.map((m) => m.date / 1000);
  const ys = sorted.map((m) => m.rawGlucose);
  const sum1 = average(xs.map((x, i) => x * ys[i]!)) - average(xs) * average(ys);
  const sum2 = average(xs.map((x) => x * x)) - Math.pow(average(xs), 2);
  const slope = sum1 / sum2;
  const intercept = average(ys) - slope * average(xs);
  const prediction = intercept + slope * (futureDate / 1000);
  return createMeasurement({
    date: futureDate,
    rawGlucose: roundHalfAwayFromZero(prediction),
    rawTemperature: first.rawTemperature,
    rawTemperatureAdjustment: first.rawTemperatureAdjustment,
  });
}
