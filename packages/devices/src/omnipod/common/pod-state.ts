/**
 * Transport independent pod state: setup progress, the last status snapshot and fault summary.
 * Condensed port of the parts of `PumpManager/PodState.swift` (OmnipodKit, MIT License,
 * (c) LoopKit Authors) that are not tied to LoopKit or to a radio. Everything is plain,
 * JSON-serialisable data; updates return new objects.
 */
import type { Millis } from '@buddy/core';
import type { DetailedStatus, StatusResponseBlock } from './blocks/types';
import { hasFault, formatFault } from './fault-codes';
import {
  POD,
  deliveryIsBolusing,
  deliveryIsSuspended,
  deliveryIsTempBasalRunning,
  podProgressName,
  type AlertSet,
  type DeliveryStatus,
  type PodProgress,
} from './pod-constants';

export const SetupProgress = {
  none: 'none',
  podPaired: 'podPaired',
  startingPrime: 'startingPrime',
  priming: 'priming',
  settingInitialBasalSchedule: 'settingInitialBasalSchedule',
  initialBasalScheduleSet: 'initialBasalScheduleSet',
  startingInsertCannula: 'startingInsertCannula',
  cannulaInserting: 'cannulaInserting',
  completed: 'completed',
  activationTimeout: 'activationTimeout',
  podIncompatible: 'podIncompatible',
} as const;
export type SetupProgress = (typeof SetupProgress)[keyof typeof SetupProgress];

export const setupIsPaired = (p: SetupProgress): boolean => p !== 'none' && p !== 'activationTimeout' && p !== 'podIncompatible';
export const setupNeedsInitialBasal = (p: SetupProgress): boolean => p === 'none' || p === 'podPaired' || p === 'startingPrime' || p === 'priming' || p === 'settingInitialBasalSchedule';

export interface PodStatusSnapshot {
  readonly receivedAt: Millis;
  readonly deliveryStatus: DeliveryStatus;
  readonly podProgress: PodProgress;
  /** seconds since activation */
  readonly timeActive: number;
  /** pod units; `POD.reservoirLevelAboveThresholdMagicNumber` means "more than 50 U" */
  readonly reservoirLevel: number;
  readonly insulinDelivered: number;
  readonly bolusNotDelivered: number;
  readonly lastProgrammingMessageSeqNum: number;
  readonly alerts: AlertSet;
}

export interface PodFault {
  readonly code: number;
  readonly description: string;
  readonly podProgress: PodProgress;
  readonly timeSinceActivation: number | null;
  readonly totalInsulinDelivered: number;
  /** units of the running immediate bolus the pod had not delivered when it faulted */
  readonly bolusNotDelivered: number;
}

export function snapshotFromStatus(s: StatusResponseBlock, at: Millis): PodStatusSnapshot {
  return {
    receivedAt: at,
    deliveryStatus: s.deliveryStatus,
    podProgress: s.podProgress,
    timeActive: s.timeActive,
    reservoirLevel: s.reservoirLevel,
    insulinDelivered: s.insulinDelivered,
    bolusNotDelivered: s.bolusNotDelivered,
    lastProgrammingMessageSeqNum: s.lastProgrammingMessageSeqNum,
    alerts: s.alerts,
  };
}

/** Status derived from a detailed status (OmnipodKit's `StatusResponse(detailedStatus:)`). */
export function statusFromDetailed(d: DetailedStatus): StatusResponseBlock {
  return {
    type: 'statusResponse',
    deliveryStatus: d.deliveryStatus,
    podProgress: d.podProgress,
    timeActive: d.timeActive,
    reservoirLevel: d.reservoirLevel,
    insulinDelivered: d.totalInsulinDelivered,
    bolusNotDelivered: d.bolusNotDelivered,
    lastProgrammingMessageSeqNum: d.lastProgrammingMessageSeqNum,
    alerts: d.unacknowledgedAlerts,
  };
}

export function faultFromDetailed(d: DetailedStatus): PodFault {
  return {
    code: d.faultEventCode.raw,
    description: hasFault(d.faultEventCode) ? formatFault(d.faultEventCode) : podProgressName(d.podProgress),
    podProgress: d.podProgress,
    timeSinceActivation: d.faultEventTimeSinceActivation,
    totalInsulinDelivered: d.totalInsulinDelivered,
    bolusNotDelivered: d.bolusNotDelivered,
  };
}

/** Reservoir in units, or null while the pod only reports "more than 50 U". */
export const reservoirUnitsOf = (s: PodStatusSnapshot): number | null =>
  s.reservoirLevel >= POD.reservoirLevelAboveThresholdMagicNumber - 0.001 ? null : s.reservoirLevel;

export const snapshotSuspended = (s: PodStatusSnapshot): boolean => deliveryIsSuspended(s.deliveryStatus);
export const snapshotBolusing = (s: PodStatusSnapshot): boolean => deliveryIsBolusing(s.deliveryStatus);
export const snapshotTempBasalRunning = (s: PodStatusSnapshot): boolean => deliveryIsTempBasalRunning(s.deliveryStatus);

/** Units the pod has delivered of a bolus of `requested` U, given the pod's `bolusNotDelivered`. */
export const deliveredOfBolus = (requested: number, bolusNotDelivered: number): number =>
  Math.max(0, Math.min(requested, Math.round((requested - bolusNotDelivered) * POD.pulsesPerUnit) / POD.pulsesPerUnit));
