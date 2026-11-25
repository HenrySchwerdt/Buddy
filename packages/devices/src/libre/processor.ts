/**
 * TypeScript port of the data pipeline in `LibreTransmitter/LibreTransmitterManager+Transmitters.swift`,
 * `LibreTransmitter/LibreTransmitterManager+Libre2EU.swift`, the helpers `createBloodSugarPrediction`,
 * `getStartDateForFilter` and `glucosesToSamplesFilter` of `LibreTransmitter/LibreTransmitterManagerV3.swift`,
 * and `LibreSensor/LibreError.swift` from loopandlearn/LibreTransmitter (MIT, (c) the LibreTransmitter
 * / LoopKit authors). Notifications, HealthKit and LoopKit glue are not ported.
 *
 * Deliberate additions (safety): readings whose FRAM record carries an error bit, and readings
 * outside the plausible 39..401 mg/dL range, are dropped before they reach Buddy.
 */
import type { Clock, GlucoseReading } from '@buddy/core';
import { isPlausibleGlucose } from '../trend';
import type { CalibrationInfo } from './calibration';
import { byteSwap16 } from './crc';
import type { LibreBleResponse } from './libre2-crypto';
import {
  fromHistoryMeasurements, fromTrendMeasurements, getGlucoseTrend, isStateValid, roundedGlucose, toBuddyTrend,
  type LibreGlucose, type LibreGlucoseTrend,
} from './libre-glucose';
import { calibratedGlucose, type Measurement } from './measurement';
import { predictBloodSugar, type SensorData } from './sensor-data';
import { sensorTypeFromPatchInfo } from './sensor-type';
import type { LibreTransmitterMetadata } from './transmitters';

export const LibreErrorDescription = {
  noSensorData: 'No sensor data present',
  noValidSensorData: 'No valid sensor data present, but sensor is running. Maybe due to sensor being off-body?',
  noCalibrationData: 'No calibration data present',
  invalidCalibrationData: 'invalid calibration data detected',
  checksumValidationError: 'Checksum Validation Error ',
  expiredSensor: 'Sensor has expired',
  encryptedSensor: 'Encrypted or unsupported libre sensor detected.',
} as const;
export type LibreError = keyof typeof LibreErrorDescription;

export type LibreUpdateResult =
  | { readonly kind: 'newData'; readonly readings: GlucoseReading[] }
  | { readonly kind: 'noData' }
  | { readonly kind: 'throttled' }
  | { readonly kind: 'error'; readonly error: LibreError };

/** Where factory calibration lives (keychain in Swift, `SecretStore` in Buddy). */
export interface CalibrationStore {
  get(): Promise<CalibrationInfo | null>;
  set(calibration: CalibrationInfo): Promise<void>;
}

/** Swift `CalibrationToSensorMapping`. */
export interface CalibrationMapping {
  readonly uuidHex: string;
  readonly reverseFooterCRC: number;
}

export interface ProcessorOptions {
  readonly source: string;
  readonly clock: Clock;
  /** `UserDefaults.mmBackfillFromHistory` (default true). */
  readonly backfillFromHistory?: boolean;
  /** `Features.allowOneMinuteReadings` (default false: one Libre 2 reading per 4.5 min). */
  readonly allowOneMinuteReadings?: boolean;
}

interface Sample {
  readonly glucose: LibreGlucose;
  readonly trend: LibreGlucoseTrend | null;
}

const PREDICTION_MINUTES = 10;

/** Holds the manager state Swift keeps on `LibreTransmitterManagerV3`. */
export class LibreReadingProcessor {
  latestBackfill: LibreGlucose | null = null;
  latestPrediction: LibreGlucose | null = null;
  private countTimesWithoutData = 0;
  private lastDirectUpdate: number | null = null;

  constructor(private readonly options: ProcessorOptions) {}

  /** `getStartDateForFilter()`: one second after the latest backfill (exclusive). */
  private startDateForFilter(): number | null {
    return this.latestBackfill ? this.latestBackfill.timestamp + 1000 : null;
  }

  /** `glucosesToSamplesFilter(_:startDate:calculateTrends:)`. */
  private toSamples(array: readonly LibreGlucose[], startDate: number | null, calculateTrends = true): Sample[] {
    const glucoses = array.filter(isStateValid);
    const newest = glucoses[0];
    const oldest = glucoses[glucoses.length - 1];
    const trend = calculateTrends && newest && oldest && newest !== oldest ? getGlucoseTrend(newest, oldest) : null;
    return glucoses.filter((g) => startDate === null || g.timestamp >= startDate).map((glucose) => ({ glucose, trend }));
  }

  /** `createBloodSugarPrediction`: informational only, as in Swift. */
  private createPrediction(measurements: readonly Measurement[], calibration: CalibrationInfo): LibreGlucose | null {
    const all = [...measurements].sort((a, b) => b.date - a.date);
    if (all.length <= 15) return null;
    const predicted = predictBloodSugar(all, PREDICTION_MINUTES);
    if (!predicted) return null;
    const bg = calibratedGlucose(predicted, calibration);
    return { unsmoothedGlucose: bg, glucoseDouble: bg, timestamp: predicted.date - PREDICTION_MINUTES * 60_000, hasError: false };
  }

  private toReadings(samples: readonly Sample[]): GlucoseReading[] {
    return samples.flatMap(({ glucose, trend }) => {
      const value = roundedGlucose(glucose);
      if (glucose.hasError || !isPlausibleGlucose(value)) return [];
      const t = toBuddyTrend(trend);
      return [{ date: glucose.timestamp, value, source: this.options.source, ...(t ? { trend: t } : {}) }];
    });
  }

  private finish(samples: readonly Sample[], glucose: readonly LibreGlucose[]): LibreUpdateResult {
    if (samples.length === 0) this.countTimesWithoutData++;
    else {
      this.latestBackfill = glucose.reduce<LibreGlucose | null>((max, g) => (max === null || g.timestamp > max.timestamp ? g : max), null);
      this.countTimesWithoutData = 0;
    }
    // several empty readouts from a running sensor: most likely ripped off the body
    if (this.countTimesWithoutData > 1) return { kind: 'error', error: 'noValidSensorData' };
    if (samples.length === 0) return { kind: 'noData' };
    return { kind: 'newData', readings: this.toReadings(samples) };
  }

  /** `libreTransmitterDidUpdate(with:and:)` + `handleGoodReading` (MiaoMiao / Bubble FRAM). */
  async transmitterDidUpdate(input: SensorData, device: LibreTransmitterMetadata, calibrationStore: CalibrationStore): Promise<LibreUpdateResult> {
    let sensorData = input;
    if (!sensorData.isLikelyLibre1FRAM) {
      const patchInfo = sensorData.patchInfo;
      if (!patchInfo) return { kind: 'error', error: 'encryptedSensor' };
      const type = sensorTypeFromPatchInfo(patchInfo);
      if ((type === 'Libre 2' || type === 'Libre US 14d') && device.uid) sensorData = sensorData.decrypted(patchInfo, device.uid);
    }
    if (!sensorData.hasValidCRCs) return { kind: 'error', error: 'checksumValidationError' };
    if (sensorData.state !== 'ready' && sensorData.state !== 'starting') return { kind: 'error', error: 'expiredSensor' };

    let calibration = await calibrationStore.get();
    if (!calibration || calibration.isValidForFooterWithReverseCRCs !== byteSwap16(sensorData.footerCrc)) {
      calibration = sensorData.calibrationData;
      try {
        await calibrationStore.set(calibration);
      } catch {
        return { kind: 'error', error: 'invalidCalibrationData' };
      }
    }

    // readingToGlucose
    const trendMeasurements = sensorData.trendMeasurements();
    this.latestPrediction = this.createPrediction(trendMeasurements, calibration);
    const trends = fromTrendMeasurements(trendMeasurements, calibration);
    const historical = this.options.backfillFromHistory === false ? [] : fromHistoryMeasurements(sensorData.historyMeasurements(), calibration);

    const startDate = this.startDateForFilter();
    // trends are one minute apart and give the arrow; only the newest one is reported
    const newestTrend = this.toSamples(trends, startDate).slice(0, 1);
    // history is 15 minutes apart: no arrow
    const history = historical.length > 0 ? this.toSamples(historical, startDate, false) : [];
    return this.finish([...history, ...newestTrend], trends);
  }

  /** `libreSensorDidUpdate(with:and:)` (Libre 2 EU direct BLE). */
  sensorDidUpdate(ble: LibreBleResponse, sensorUidHex: string, calibration: CalibrationInfo | null, mapping: CalibrationMapping | null): LibreUpdateResult {
    const now = this.options.clock.now();
    const minutes = this.options.allowOneMinuteReadings ? 0.8 : 4.5;
    if (this.lastDirectUpdate !== null && this.lastDirectUpdate + minutes * 60_000 >= now) return { kind: 'throttled' };

    if (!mapping || !calibration) return { kind: 'error', error: 'noCalibrationData' };
    // calibration must belong to these packets; recovering requires re-pairing
    if (mapping.reverseFooterCRC !== calibration.isValidForFooterWithReverseCRCs || mapping.uuidHex !== sensorUidHex) {
      return { kind: 'error', error: 'noCalibrationData' };
    }

    const sorted = [...ble.trend].sort((a, b) => b.date - a.date);
    const glucose = fromTrendMeasurements(sorted, calibration);
    // all trend elements are needed for the arrow, but only the newest is reported
    const samples = this.toSamples(glucose, this.startDateForFilter()).slice(0, 1);
    if (samples.length > 0) this.latestPrediction = this.createPrediction(ble.trend, calibration);
    const result = this.finish(samples, glucose);
    this.lastDirectUpdate = now;
    return result;
  }
}
