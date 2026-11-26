/**
 * Pod constants and enums. Port of `OmnipodCommon/Pod.swift`, `PodProgressStatus.swift`,
 * `BeepType.swift`, `PodType.swift` and the alert slot enums of `AlertSlot.swift` from OmnipodKit
 * (MIT License, (c) LoopKit Authors). Time values are seconds, insulin values units.
 */

export const MINUTE = 60;
export const HOUR = 3600;

export const POD = {
  pulseSize: 0.05,
  pulsesPerUnit: 20,
  secondsPerBolusPulse: 2,
  secondsPerPrimePulse: 1,
  /** U/s while priming or inserting the cannula */
  primeDeliveryRate: 0.05 / 1,
  expirationAdvisoryWindow: 7 * HOUR,
  endOfServiceImminentWindow: 1 * HOUR,
  serviceDuration: 80 * HOUR,
  /** 80 h service - 1 h imminent - 7 h advisory = 72 h */
  nominalPodLife: 72 * HOUR,
  maximumReservoirReading: 50,
  /** The pod reports 51.15 U when more than 50 U remain. */
  reservoirLevelAboveThresholdMagicNumber: 51.15,
  reservoirCapacity: 200,
  nearZeroBasalRate: 0.01,
  maximumBasalScheduleEntryCount: 24,
  primeUnits: 2.6,
  cannulaInsertionUnits: 0.5,
  /** Safety limits of the pod itself; Buddy never raises them. */
  maximumBasalUnitsPerHour: 30,
  maximumBolusUnits: 30,
  /** Longest supported temp basal: 24 half-hour segments */
  maximumTempBasalMinutes: 12 * 60,
} as const;

/** The pod's message nonce on DASH is a fixed value ("INS."); Eros uses a rolling one. */
export const DASH_FIXED_NONCE = 0x494e532e;

export const PodModel = { unknown: 0, eros: 2, dash: 4, omnipod5: 5 } as const;

export const DeliveryStatus = {
  suspended: 0,
  scheduledBasal: 1,
  tempBasalRunning: 2,
  /** bolusing while suspended, should only occur during priming */
  priming: 4,
  bolusInProgress: 5,
  bolusAndTempBasal: 6,
  extendedBolusWhileSuspended: 8,
  extendedBolusRunning: 9,
  extendedBolusAndTempBasal: 10,
} as const;
export type DeliveryStatus = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

const DELIVERY_VALUES = new Set<number>(Object.values(DeliveryStatus));
export const isDeliveryStatus = (v: number): v is DeliveryStatus => DELIVERY_VALUES.has(v);

export const deliveryIsSuspended = (s: DeliveryStatus): boolean =>
  s === DeliveryStatus.suspended || s === DeliveryStatus.priming || s === DeliveryStatus.extendedBolusWhileSuspended;
export const deliveryIsBolusing = (s: DeliveryStatus): boolean =>
  s === DeliveryStatus.bolusInProgress ||
  s === DeliveryStatus.bolusAndTempBasal ||
  s === DeliveryStatus.extendedBolusRunning ||
  s === DeliveryStatus.extendedBolusAndTempBasal ||
  s === DeliveryStatus.priming ||
  s === DeliveryStatus.extendedBolusWhileSuspended;
export const deliveryIsTempBasalRunning = (s: DeliveryStatus): boolean =>
  s === DeliveryStatus.tempBasalRunning || s === DeliveryStatus.bolusAndTempBasal || s === DeliveryStatus.extendedBolusAndTempBasal;

export const PodProgress = {
  initialized: 0,
  memoryInitialized: 1,
  reminderInitialized: 2,
  pairingCompleted: 3,
  priming: 4,
  primingCompleted: 5,
  basalInitialized: 6,
  insertingCannula: 7,
  aboveFiftyUnits: 8,
  fiftyOrLessUnits: 9,
  oneNotUsed: 10,
  twoNotUsed: 11,
  threeNotUsed: 12,
  faultEventOccurred: 13,
  /** took > 2 h from progress 2 to 3 or > 1 h from 3 to 8 */
  activationTimeExceeded: 14,
  /** pod deactivated or a fatal packet state error */
  inactive: 15,
} as const;
export type PodProgress = (typeof PodProgress)[keyof typeof PodProgress];

export const podProgressName = (p: PodProgress): string =>
  (Object.keys(PodProgress) as (keyof typeof PodProgress)[]).find((k) => PodProgress[k] === p) ?? `progress${p}`;

export const podProgressReadyForDelivery = (p: PodProgress): boolean => p === PodProgress.fiftyOrLessUnits || p === PodProgress.aboveFiftyUnits;

export const BeepType = {
  noBeepCancel: 0x0,
  beepBeepBeepBeep: 0x1,
  bipBeepBipBeepBipBeepBipBeep: 0x2,
  bipBip: 0x3,
  beep: 0x4,
  beepBeepBeep: 0x5,
  beeeeeep: 0x6,
  bipBipBipbipBipBip: 0x7,
  beeepBeeep: 0x8,
  beepBeep: 0xb,
  beeep: 0xc,
  bipBeeeeep: 0xd,
  fiveSecondBeep: 0xe,
  noBeepNonCancel: 0xf,
} as const;
export type BeepType = (typeof BeepType)[keyof typeof BeepType];

const BEEP_VALUES = new Set<number>([...Object.values(BeepType), 0x9, 0xa]);
export const isBeepType = (v: number): boolean => BEEP_VALUES.has(v);

export const AlertSlot = {
  autoOff: 0,
  notUsed: 1,
  shutdownImminent: 2,
  expirationReminder: 3,
  lowReservoir: 4,
  suspendedReminder: 5,
  suspendTimeExpired: 6,
  expired: 7,
} as const;
export type AlertSlot = (typeof AlertSlot)[keyof typeof AlertSlot];

/** Bit mask of alert slots (bit n = slot n), as used by status responses and acknowledge commands. */
export type AlertSet = number;
export const alertSetOf = (...slots: readonly AlertSlot[]): AlertSet => slots.reduce<number>((m, s) => m | (1 << s), 0);
export const alertSetHas = (set: AlertSet, slot: AlertSlot): boolean => (set & (1 << slot)) !== 0;
export const ALL_ALERTS: AlertSet = 0xff;

export const BeepRepeat = {
  once: 0,
  every1MinuteFor3MinutesAndRepeatEvery60Minutes: 1,
  every1MinuteFor15Minutes: 2,
  every1MinuteFor3MinutesAndRepeatEvery15Minutes: 3,
  every3MinutesFor60minutesStartingAt2Minutes: 4,
  every60Minutes: 5,
  every15Minutes: 6,
  every15MinutesFor60minutesStartingAt14Minutes: 7,
  every5Minutes: 8,
} as const;
export type BeepRepeat = (typeof BeepRepeat)[keyof typeof BeepRepeat];
