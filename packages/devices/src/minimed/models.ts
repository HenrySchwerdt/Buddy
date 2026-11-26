/**
 * TypeScript port of `Models/PumpModel.swift` and `Models/PumpRegion.swift` from MinimedKit
 * (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors): what differs between the
 * Medtronic MiniMed generations (record layout, insulin resolution, delivery speed).
 *
 * DEVIATION: the supported-volume lookups tolerate 1e-9 of floating point noise, so a rate the
 * loop computed as 0.30000000000000004 still maps to the 0.3 step instead of falling to 0.275.
 */

export const PUMP_MODELS = ['508', '511', '711', '512', '712', '515', '715', '522', '722', '523', '723', '530', '730', '540', '740', '551', '751', '554', '754'] as const;
export type PumpModel = (typeof PUMP_MODELS)[number];

export const isPumpModel = (v: unknown): v is PumpModel => typeof v === 'string' && (PUMP_MODELS as readonly string[]).includes(v);

/** `NA` and `WW` are the two RF bands of the pumps (Canada uses the North America band). */
export type PumpRegion = 'NA' | 'WW';
export const isPumpRegion = (v: unknown): v is PumpRegion => v === 'NA' || v === 'WW';

const EPS = 1e-9;
const MINUTE_MS = 60_000;

const generation = (m: PumpModel): number => Number(m) % 100;
const size = (m: PumpModel): number => Math.floor(Number(m) / 100);

/** The x23 and later pumps use the larger record format ("larger" flag of decoding-carelink). */
export const isLargerModel = (m: PumpModel): boolean => generation(m) >= 23;
/** On x23+ pumps square wave boluses are added to the history when delivery starts. */
export const appendsSquareWaveOnStart = (m: PumpModel): boolean => generation(m) >= 23;
export const hasMySentry = (m: PumpModel): boolean => generation(m) >= 23;
export const hasLowSuspend = (m: PumpModel): boolean => generation(m) >= 51;
/** Strokes per unit in bolus messages and history records (higher precision on x23+). */
export const insulinBitPackingScale = (m: PumpModel): number => (generation(m) >= 23 ? 40 : 10);
export const pulsesPerUnit = (m: PumpModel): number => (generation(m) >= 23 ? 40 : 20);
export const isDeliveryRateVariable = (m: PumpModel): boolean => generation(m) >= 23;
export const maximumBolusVolume = 25;
export const maximumBasalRate = 35;
export const maximumBasalScheduleEntryCount = 48;

export function reservoirCapacity(m: PumpModel): number {
  switch (size(m)) {
    case 5:
      return 176;
    case 7:
      return 300;
    default:
      throw new Error(`Unknown reservoir capacity for pump model ${m}`);
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const basalRateCache = new Map<PumpModel, readonly number[]>();
const bolusVolumeCache = new Map<PumpModel, readonly number[]>();

/** Every basal rate (U/h) the pump can run, ascending. */
export function supportedBasalRates(m: PumpModel): readonly number[] {
  const cached = basalRateCache.get(m);
  if (cached) return cached;
  const rates =
    generation(m) >= 23
      ? [
          ...range(0, 39).map((n) => n / pulsesPerUnit(m)), // 0.025 steps below 1 U/h
          ...range(20, 199).map((n) => n / (pulsesPerUnit(m) / 2)), // 0.05 steps up to 10 U/h
          ...range(100, 350).map((n) => n / (pulsesPerUnit(m) / 4)), // 0.1 steps up to 35 U/h
        ]
      : range(0, 700).map((n) => n / pulsesPerUnit(m)); // 0.05 steps
  basalRateCache.set(m, rates);
  return rates;
}

/** Every bolus amount (U) the pump can deliver, ascending. */
export function supportedBolusVolumes(m: PumpModel): readonly number[] {
  const cached = bolusVolumeCache.get(m);
  if (cached) return cached;
  const volumes =
    generation(m) >= 23
      ? [...range(1, 40).map((n) => n / 40), ...range(21, 200).map((n) => n / 20), ...range(101, 250).map((n) => n / 10)]
      : range(1, maximumBolusVolume * 10).map((n) => n / 10);
  bolusVolumeCache.set(m, volumes);
  return volumes;
}

/** Largest supported basal rate not above `unitsPerHour` (0 when below the first step). */
export function roundToSupportedBasalRate(m: PumpModel, unitsPerHour: number): number {
  let best = 0;
  for (const r of supportedBasalRates(m)) {
    if (r <= unitsPerHour + EPS) best = r;
    else break;
  }
  return best;
}

/** Largest supported bolus not above `units` (0 when below the smallest step): never more than asked. */
export function roundToSupportedBolusVolume(m: PumpModel, units: number): number {
  let best = 0;
  for (const v of supportedBolusVolumes(m)) {
    if (v <= units + EPS) best = v;
    else break;
  }
  return best;
}

/** How long the pump takes to deliver `units`, in ms. */
export function bolusDeliveryTimeMs(m: PumpModel, units: number): number {
  let unitsPerMinute = 1.5;
  if (isDeliveryRateVariable(m)) {
    if (units < 1.0) unitsPerMinute = 0.75;
    else if (units > 7.5) unitsPerMinute = units / 5;
  }
  return (units / unitsPerMinute) * MINUTE_MS;
}

/** Temp basal delivery after `elapsedMs`, rounded to the pump's pulse size. */
export function estimateTempBasalProgress(m: PumpModel, unitsPerHour: number, durationMs: number, elapsedMs: number): { deliveredUnits: number; progress: number } {
  const ppu = pulsesPerUnit(m);
  const deliveredUnits = Math.round(unitsPerHour * (elapsedMs / 3_600_000) * ppu) / ppu;
  return { deliveredUnits, progress: Math.min(elapsedMs / durationMs, 1) };
}

/** Bolus delivery after `elapsedMs` of a bolus of `programmedUnits`. */
export function estimateBolusProgress(m: PumpModel, elapsedMs: number, programmedUnits: number): { deliveredUnits: number; progress: number } {
  const durationMs = bolusDeliveryTimeMs(m, programmedUnits);
  const timeProgress = Math.min(elapsedMs / durationMs, 1);
  let resolution: number;
  let unrounded: number;
  if (isDeliveryRateVariable(m)) {
    if (programmedUnits < 1) {
      resolution = 40;
      unrounded = timeProgress * programmedUnits;
    } else {
      const baseRate = 1.5 / MINUTE_MS; // U per ms
      let remaining = programmedUnits;
      const baseDuration = Math.min(durationMs, remaining / baseRate);
      remaining -= baseDuration * baseRate;
      const overlay1 = Math.min(durationMs, remaining / baseRate);
      remaining -= overlay1 * baseRate;
      const overlay2 = Math.min(durationMs, remaining / baseRate);
      unrounded = (Math.min(elapsedMs, baseDuration) + Math.min(elapsedMs, overlay1) + Math.min(elapsedMs, overlay2)) * baseRate;
      resolution = overlay1 > elapsedMs ? 10 : 20;
    }
  } else {
    resolution = 20;
    unrounded = timeProgress * programmedUnits;
  }
  const deliveredUnits = Math.round(unrounded * resolution) / resolution;
  return { deliveredUnits: Math.min(deliveredUnits, programmedUnits), progress: programmedUnits > 0 ? Math.min(deliveredUnits / programmedUnits, 1) : 1 };
}

// ── RF bands ─────────────────────────────────────────────────────────────────

/** Where the pump is expected when it was never tuned: 916.5 MHz (North America) / 868.35 MHz (world-wide). */
export const DEFAULT_FREQUENCY_MHZ: Readonly<Record<PumpRegion, number>> = { NA: 916.5, WW: 868.35 };

/** Channels the radio tune scans, per region (`PumpRegion.scanFrequencies`). */
export const SCAN_FREQUENCIES_MHZ: Readonly<Record<PumpRegion, readonly number[]>> = {
  WW: [868.25, 868.3, 868.35, 868.4, 868.45, 868.5, 868.55, 868.6, 868.65],
  NA: [916.45, 916.5, 916.55, 916.6, 916.65, 916.7, 916.75, 916.8],
};

/** `BatteryChemistryType`: alkaline AAA cells (default) or lithium. */
export type BatteryChemistry = 'alkaline' | 'lithium';
const CHEMISTRY: Readonly<Record<BatteryChemistry, { min: number; max: number }>> = { alkaline: { min: 1.18, max: 1.47 }, lithium: { min: 1.32, max: 1.58 } };

/** 0..100 from the battery voltage the pump reports (`BatteryChemistryType.chargeRemaining`). */
export function batteryPercentFromVolts(volts: number, chemistry: BatteryChemistry = 'alkaline'): number {
  const { min, max } = CHEMISTRY[chemistry];
  return Math.round(Math.max(0, Math.min(1, (volts - min) / (max - min))) * 100);
}
