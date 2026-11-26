/**
 * Convenience constructors for the command blocks the driver sends. Port of the convenience
 * initialisers of `SetInsulinScheduleCommand`, `BolusExtraCommand`, `TempBasalExtraCommand` and
 * `BasalScheduleExtraCommand` from OmnipodKit (MIT License, (c) LoopKit Authors).
 */
import { adjacentEqualRatesMerged, entryDurations, rateAt, type BasalSchedule } from '../basal-schedule';
import {
  SEGMENT_DURATION,
  basalTableFromSchedule,
  basalTableFromTempBasal,
  immediateBolusTable,
  makeRateEntries,
  rateEntryDuration,
  roundToSupportedBasalTimingRate,
} from '../insulin-table';
import { HOUR, MINUTE, POD } from '../pod-constants';
import type { BasalScheduleExtraBlock, BolusExtraBlock, SetInsulinScheduleBlock, TempBasalExtraBlock } from './types';

const NO_BEEPS = { acknowledgementBeep: false, completionBeep: false, programReminderInterval: 0 } as const;

// ── bolus (immediate only; also used for priming and cannula insertion) ─────

export function bolusScheduleBlocks(nonce: number, units: number, timeBetweenPulses: number = POD.secondsPerBolusPulse): [SetInsulinScheduleBlock, BolusExtraBlock] {
  const between = timeBetweenPulses > 0 ? timeBetweenPulses : POD.secondsPerBolusPulse;
  return [
    { type: 'setInsulinSchedule', nonce, schedule: { kind: 'bolus', units, timeBetweenPulses: between, table: immediateBolusTable(units) } },
    { type: 'bolusExtra', ...NO_BEEPS, units, timeBetweenPulses: between, extendedUnits: 0, extendedDuration: 0 },
  ];
}

// ── temp basal ──────────────────────────────────────────────────────────────

export function tempBasalBlocks(nonce: number, rate: number, durationSeconds: number, zeroBasalRate: number): [SetInsulinScheduleBlock, TempBasalExtraBlock] {
  const pulsesPerHour = Math.round(rate / POD.pulseSize);
  const rateEntries = makeRateEntries(rate, durationSeconds, zeroBasalRate);
  return [
    {
      type: 'setInsulinSchedule',
      nonce,
      schedule: { kind: 'tempBasal', secondsRemaining: 30 * MINUTE, firstSegmentPulses: pulsesPerHour >> 1, table: basalTableFromTempBasal(rate, durationSeconds) },
    },
    { type: 'tempBasalExtra', ...NO_BEEPS, remainingPulses: rateEntries[0]!.totalPulses, delayUntilFirstPulse: rateEntries[0]!.delayBetweenPulses, rateEntries },
  ];
}

// ── scheduled basal ─────────────────────────────────────────────────────────

export function basalScheduleBlocks(
  nonce: number,
  schedule: BasalSchedule,
  scheduleOffset: number,
  zeroBasalRate: number,
): [SetInsulinScheduleBlock, BasalScheduleExtraBlock] {
  const offset = Math.round(scheduleOffset);
  let rate = roundToSupportedBasalTimingRate(rateAt(schedule, offset), zeroBasalRate);
  if (rate === 0) rate = POD.nearZeroBasalRate;
  const segment = Math.trunc(offset / SEGMENT_DURATION);
  const segmentOffset = Math.round(offset % SEGMENT_DURATION);
  const timeRemainingInSegment = SEGMENT_DURATION - segmentOffset;
  const timeBetweenPulses = HOUR / (rate / POD.pulseSize);
  const offsetToNextTenth = timeRemainingInSegment % (timeBetweenPulses / 10);
  const pulsesRemainingInSegment = (timeRemainingInSegment + timeBetweenPulses / 10 - offsetToNextTenth) / timeBetweenPulses;
  const setSchedule: SetInsulinScheduleBlock = {
    type: 'setInsulinSchedule',
    nonce,
    schedule: {
      kind: 'basalSchedule',
      currentSegment: segment,
      secondsRemaining: Math.trunc(timeRemainingInSegment),
      pulsesRemaining: Math.trunc(pulsesRemainingInSegment),
      table: basalTableFromSchedule((o) => rateAt(schedule, o)),
    },
  };
  return [setSchedule, basalScheduleExtraBlock(schedule, offset, zeroBasalRate)];
}

function basalScheduleExtraBlock(schedule: BasalSchedule, scheduleOffset: number, zeroBasalRate: number): BasalScheduleExtraBlock {
  const merged = adjacentEqualRatesMerged(schedule.entries);
  const rateEntries = entryDurations(merged).flatMap((e) => makeRateEntries(e.rate, e.duration, zeroBasalRate));
  let t = 0;
  for (let index = 0; index < rateEntries.length; index++) {
    const entry = rateEntries[index]!;
    const duration = rateEntryDuration(entry);
    if (scheduleOffset >= t && scheduleOffset <= t + duration) {
      const timeRemaining = t + duration - scheduleOffset;
      const pulsesRemaining = entry.totalPulses * (timeRemaining / duration);
      return {
        type: 'basalScheduleExtra',
        ...NO_BEEPS,
        currentEntryIndex: index,
        delayUntilNextTenthOfPulse: timeRemaining % (entry.delayBetweenPulses / 10),
        remainingPulses: pulsesRemaining === 0 ? 0.1 : Math.ceil(pulsesRemaining * 10) / 10,
        rateEntries,
      };
    }
    t += duration;
  }
  throw new Error('RateEntry schedule incomplete');
}
