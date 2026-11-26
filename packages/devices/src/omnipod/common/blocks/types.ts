/**
 * Message block types. Port of `OmnipodCommon/MessageBlocks/*.swift` from OmnipodKit
 * (MIT License, (c) LoopKit Authors), as a tagged union instead of Swift structs.
 *
 * DELIBERATELY NOT PORTED: Omnipod 5 only fields (`BolusInfo`, O5 signing) and extended bolus
 * programming. Pulse log pod info is kept as raw bytes.
 */
import type { Bytes } from '@buddy/core';
import type { AlertSet, AlertSlot, BeepRepeat, BeepType, DeliveryStatus, PodProgress } from '../pod-constants';
import type { InsulinTableEntry, RateEntry } from '../insulin-table';
import type { FaultEventCode } from '../fault-codes';

export const MessageBlockType = {
  versionResponse: 0x01,
  podInfoResponse: 0x02,
  setupPod: 0x03,
  errorResponse: 0x06,
  assignAddress: 0x07,
  faultConfig: 0x08,
  getStatus: 0x0e,
  acknowledgeAlert: 0x11,
  basalScheduleExtra: 0x13,
  tempBasalExtra: 0x16,
  bolusExtra: 0x17,
  configureAlerts: 0x19,
  setInsulinSchedule: 0x1a,
  deactivatePod: 0x1c,
  statusResponse: 0x1d,
  beepConfig: 0x1e,
  cancelDelivery: 0x1f,
} as const;
export type MessageBlockTypeName = keyof typeof MessageBlockType;

export const PodInfoType = {
  normal: 0x00,
  triggeredAlerts: 0x01,
  detailedStatus: 0x02,
  pulseLogPlus: 0x03,
  activationTime: 0x05,
  /** DASH only: normal status without advancing the message sequence number */
  noSeqStatus: 0x07,
  pulseLogRecent: 0x50,
  pulseLogPrevious: 0x51,
} as const;
export type PodInfoType = (typeof PodInfoType)[keyof typeof PodInfoType];

export const CancelDeliveryType = { none: 0, basal: 1, tempBasal: 2, bolus: 4, all: 7, allButBasal: 6 } as const;

export interface BeepOptions {
  readonly acknowledgementBeep: boolean;
  readonly completionBeep: boolean;
  /** seconds, whole minutes up to 63 */
  readonly programReminderInterval: number;
}

// ── commands ────────────────────────────────────────────────────────────────

export interface GetStatusBlock {
  readonly type: 'getStatus';
  readonly podInfoType: PodInfoType;
}
export interface AssignAddressBlock {
  readonly type: 'assignAddress';
  readonly address: number;
}
export interface DateComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}
export interface SetupPodBlock {
  readonly type: 'setupPod';
  readonly address: number;
  readonly lot: number;
  readonly tid: number;
  readonly date: DateComponents;
  readonly packetTimeoutLimit: number;
}
export interface FaultConfigBlock {
  readonly type: 'faultConfig';
  readonly nonce: number;
  readonly tab5Sub16: number;
  readonly tab5Sub17: number;
}
export interface AcknowledgeAlertBlock {
  readonly type: 'acknowledgeAlert';
  readonly nonce: number;
  readonly alerts: AlertSet;
}

export type AlertTrigger =
  | { readonly kind: 'unitsRemaining'; readonly units: number }
  | { readonly kind: 'timeUntilAlert'; readonly seconds: number };

export interface AlertConfiguration {
  readonly slot: AlertSlot;
  readonly active: boolean;
  /** seconds */
  readonly duration: number;
  readonly trigger: AlertTrigger;
  readonly beepRepeat: BeepRepeat;
  readonly beepType: BeepType;
  readonly silent: boolean;
  readonly autoOffModifier: boolean;
}
export interface ConfigureAlertsBlock {
  readonly type: 'configureAlerts';
  readonly nonce: number;
  readonly configurations: readonly AlertConfiguration[];
}

export type DeliverySchedule =
  | { readonly kind: 'basalSchedule'; readonly currentSegment: number; readonly secondsRemaining: number; readonly pulsesRemaining: number; readonly table: readonly InsulinTableEntry[] }
  | { readonly kind: 'tempBasal'; readonly secondsRemaining: number; readonly firstSegmentPulses: number; readonly table: readonly InsulinTableEntry[] }
  | { readonly kind: 'bolus'; readonly units: number; readonly timeBetweenPulses: number; readonly table: readonly InsulinTableEntry[] };

export interface SetInsulinScheduleBlock {
  readonly type: 'setInsulinSchedule';
  readonly nonce: number;
  readonly schedule: DeliverySchedule;
}
export interface BolusExtraBlock extends BeepOptions {
  readonly type: 'bolusExtra';
  readonly units: number;
  /** seconds between pulses of the immediate bolus */
  readonly timeBetweenPulses: number;
  readonly extendedUnits: number;
  readonly extendedDuration: number;
}
export interface TempBasalExtraBlock extends BeepOptions {
  readonly type: 'tempBasalExtra';
  readonly remainingPulses: number;
  readonly delayUntilFirstPulse: number;
  readonly rateEntries: readonly RateEntry[];
}
export interface BasalScheduleExtraBlock extends BeepOptions {
  readonly type: 'basalScheduleExtra';
  readonly currentEntryIndex: number;
  readonly remainingPulses: number;
  readonly delayUntilNextTenthOfPulse: number;
  readonly rateEntries: readonly RateEntry[];
}
export interface CancelDeliveryBlock {
  readonly type: 'cancelDelivery';
  readonly nonce: number;
  /** bit set of {@link CancelDeliveryType} */
  readonly deliveryType: number;
  readonly beepType: BeepType;
}
export interface DeactivatePodBlock {
  readonly type: 'deactivatePod';
  readonly nonce: number;
}
export interface BeepConfigBlock {
  readonly type: 'beepConfig';
  readonly beepType: BeepType;
  readonly basalCompletionBeep: boolean;
  readonly basalIntervalBeep: number;
  readonly tempBasalCompletionBeep: boolean;
  readonly tempBasalIntervalBeep: number;
  readonly bolusCompletionBeep: boolean;
  readonly bolusIntervalBeep: number;
}

// ── responses ───────────────────────────────────────────────────────────────

export interface StatusResponseBlock {
  readonly type: 'statusResponse';
  readonly deliveryStatus: DeliveryStatus;
  readonly podProgress: PodProgress;
  /** seconds since activation */
  readonly timeActive: number;
  readonly reservoirLevel: number;
  readonly insulinDelivered: number;
  readonly bolusNotDelivered: number;
  /** message number of the last programming command the pod accepted (0..15) */
  readonly lastProgrammingMessageSeqNum: number;
  readonly alerts: AlertSet;
}

export interface VersionResponseBlock {
  readonly type: 'versionResponse';
  readonly firmwareVersion: string;
  readonly iFirmwareVersion: string;
  readonly podModel: number;
  readonly lot: number;
  readonly tid: number;
  readonly address: number;
  readonly podProgress: PodProgress;
  /** only in the (longer) setup response */
  readonly setup: null | {
    readonly pulseSize: number;
    readonly secondsPerBolusPulse: number;
    readonly secondsPerPrimePulse: number;
    readonly primeUnits: number;
    readonly cannulaInsertionUnits: number;
    /** seconds */
    readonly serviceDuration: number;
  };
}

export type ErrorResponseKind =
  | { readonly kind: 'badNonce'; readonly nonceResyncKey: number }
  | { readonly kind: 'nonretryable'; readonly code: number; readonly faultEventCode: FaultEventCode; readonly podProgress: PodProgress };
export interface ErrorResponseBlock {
  readonly type: 'errorResponse';
  readonly error: ErrorResponseKind;
}

export interface ErrorEventInfo {
  readonly raw: number;
  readonly insulinStateTableCorruption: boolean;
  readonly occlusionType: number;
  readonly immediateBolusInProgress: boolean;
  readonly podProgress: PodProgress;
}
export interface DetailedStatus {
  readonly podInfoType: typeof PodInfoType.detailedStatus;
  readonly podProgress: PodProgress;
  readonly deliveryStatus: DeliveryStatus;
  readonly bolusNotDelivered: number;
  readonly lastProgrammingMessageSeqNum: number;
  readonly totalInsulinDelivered: number;
  readonly faultEventCode: FaultEventCode;
  /** seconds since activation, null when not reported */
  readonly faultEventTimeSinceActivation: number | null;
  readonly reservoirLevel: number;
  readonly timeActive: number;
  readonly unacknowledgedAlerts: AlertSet;
  readonly faultAccessingTables: boolean;
  readonly errorEventInfo: ErrorEventInfo | null;
  readonly receiverLowGain: number;
  readonly radioRSSI: number;
  readonly previousPodProgress: PodProgress | null;
  readonly possibleFaultCallingAddress: number | null;
  readonly raw: Bytes;
}
export interface TriggeredAlertsInfo {
  readonly podInfoType: typeof PodInfoType.triggeredAlerts;
  /** seconds since activation at which each of the 8 slots triggered */
  readonly alertActivations: readonly number[];
}
export interface ActivationTimeInfo {
  readonly podInfoType: typeof PodInfoType.activationTime;
  readonly faultEventCode: FaultEventCode;
  readonly faultTime: number;
  readonly date: DateComponents;
}
export interface RawPodInfo {
  readonly podInfoType: Exclude<PodInfoType, 0x02 | 0x01 | 0x05>;
  readonly raw: Bytes;
}
export type PodInfo = DetailedStatus | TriggeredAlertsInfo | ActivationTimeInfo | RawPodInfo;
export interface PodInfoResponseBlock {
  readonly type: 'podInfoResponse';
  readonly podInfoType: PodInfoType;
  readonly info: PodInfo;
}

export type CommandBlock =
  | GetStatusBlock
  | AssignAddressBlock
  | SetupPodBlock
  | FaultConfigBlock
  | AcknowledgeAlertBlock
  | ConfigureAlertsBlock
  | SetInsulinScheduleBlock
  | BolusExtraBlock
  | TempBasalExtraBlock
  | BasalScheduleExtraBlock
  | CancelDeliveryBlock
  | DeactivatePodBlock
  | BeepConfigBlock;

export type ResponseBlock = StatusResponseBlock | VersionResponseBlock | ErrorResponseBlock | PodInfoResponseBlock;

export type MessageBlock = CommandBlock | ResponseBlock;

/** Blocks that carry the 32-bit nonce (`NonceResyncableMessageBlock`). */
export type NonceBlock = FaultConfigBlock | AcknowledgeAlertBlock | ConfigureAlertsBlock | SetInsulinScheduleBlock | CancelDeliveryBlock | DeactivatePodBlock;
export const hasNonce = (b: MessageBlock): b is NonceBlock =>
  b.type === 'faultConfig' ||
  b.type === 'acknowledgeAlert' ||
  b.type === 'configureAlerts' ||
  b.type === 'setInsulinSchedule' ||
  b.type === 'cancelDelivery' ||
  b.type === 'deactivatePod';
