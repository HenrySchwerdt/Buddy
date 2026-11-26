/**
 * The pump event types of a history page and the layout of their records: TypeScript port of
 * `Messages/Models/PumpEventType.swift` and the `length` / timestamp offset of every `*PumpEvent.swift`
 * of MinimedKit (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors).
 *
 * A page can only be walked when the length of every record is known, so the table covers all
 * types. Types the Swift code decodes as `PlaceholderPumpEvent` (7 bytes, timestamp at offset 2)
 * are listed here with that layout.
 */
import { hasLowSuspend, isLargerModel, type PumpModel } from '../models';

export interface EventLayout {
  readonly name: string;
  readonly length: number;
  /** Offset of the 5 byte timestamp; null for records without one (daily totals, unabsorbed insulin). */
  readonly timestampOffset: number | null;
}

type LayoutFn = (m: PumpModel) => EventLayout;
const fixed = (name: string, length: number, timestampOffset: number | null = 2): LayoutFn => () => ({ name, length, timestampOffset });

const TABLE = new Map<number, LayoutFn>([
  [0x01, (m) => ({ name: 'bolusNormal', length: isLargerModel(m) ? 13 : 9, timestampOffset: isLargerModel(m) ? 8 : 4 })],
  [0x03, fixed('prime', 10, 5)],
  [0x06, fixed('alarmPump', 9, 4)],
  [0x07, (m) => ({ name: 'resultDailyTotal', length: isLargerModel(m) ? 10 : 7, timestampOffset: null })],
  [0x08, fixed('changeBasalProfilePattern', 152)],
  [0x09, fixed('changeBasalProfile', 152)],
  [0x0a, fixed('calBGForPH', 7)],
  [0x0b, fixed('alarmSensor', 8, 3)],
  [0x0c, fixed('clearAlarm', 7)],
  [0x14, fixed('selectBasalProfile', 7)],
  [0x16, fixed('tempBasalDuration', 7)],
  [0x17, fixed('changeTime', 7)],
  [0x18, fixed('newTime', 7)],
  [0x19, fixed('journalEntryPumpLowBattery', 7)],
  [0x1a, fixed('battery', 7)],
  [0x1b, fixed('setAutoOff', 7)],
  [0x1e, fixed('suspend', 7)],
  [0x1f, fixed('resume', 7)],
  [0x20, fixed('selftest', 7)],
  [0x21, fixed('rewind', 7)],
  [0x22, fixed('clearSettings', 7)],
  [0x23, fixed('changeChildBlockEnable', 7)],
  [0x24, fixed('changeMaxBolus', 7)],
  [0x26, fixed('enableDisableRemote', 21)],
  [0x2c, fixed('changeMaxBasal', 7)],
  [0x2d, fixed('enableBolusWizard', 7)],
  [0x31, fixed('changeBGReminderOffset', 7)],
  [0x32, fixed('changeAlarmClockTime', 7)],
  [0x33, fixed('tempBasal', 8)],
  [0x34, fixed('journalEntryPumpLowReservoir', 7)],
  [0x35, fixed('alarmClockReminder', 7)],
  [0x36, fixed('changeMeterId', 21)],
  [0x39, fixed('meterBGx15', 10)],
  [0x3b, fixed('questionable3b', 7)],
  [0x3c, fixed('changeParadigmLinkID', 21)],
  [0x3f, fixed('bgReceived', 10)],
  [0x40, fixed('journalEntryMealMarker', 9)],
  [0x41, fixed('journalEntryExerciseMarker', 8)],
  [0x42, fixed('journalEntryInsulinMarker', 8)],
  [0x43, fixed('journalEntryOtherMarker', 7)],
  [0x44, fixed('changeSensorAutoCalEnable', 7)],
  [0x4f, fixed('changeBolusWizardSetup', 39)],
  [0x50, (m) => ({ name: 'changeSensorSetup2', length: hasLowSuspend(m) ? 41 : 37, timestampOffset: 2 })],
  [0x51, fixed('restoreMystery51', 7)],
  [0x52, fixed('restoreMystery52', 7)],
  [0x53, fixed('changeSensorAlarmSilenceConfig', 8)],
  [0x54, fixed('restoreMystery54', 64)],
  [0x55, fixed('restoreMystery55', 55)],
  [0x56, fixed('changeSensorRateOfChangeAlertSetup', 12)],
  [0x57, fixed('changeBolusScrollStepSize', 7)],
  [0x5a, (m) => ({ name: 'bolusWizardSetup', length: isLargerModel(m) ? 144 : 124, timestampOffset: 2 })],
  [0x5b, (m) => ({ name: 'bolusWizardBolusEstimate', length: isLargerModel(m) ? 22 : 20, timestampOffset: 2 })],
  [0x5c, () => ({ name: 'unabsorbedInsulin', length: 0, timestampOffset: null })], // variable, see decodeEvent
  [0x5d, fixed('saveSettings', 7)],
  [0x5e, fixed('changeVariableBolus', 7)],
  [0x5f, fixed('changeAudioBolus', 7)],
  [0x60, fixed('changeBGReminderEnable', 7)],
  [0x61, fixed('changeAlarmClockEnable', 7)],
  [0x62, fixed('changeTempBasalType', 7)],
  [0x63, fixed('changeAlarmNotifyMode', 7)],
  [0x64, fixed('changeTimeFormat', 7)],
  [0x65, fixed('changeReservoirWarningTime', 7)],
  [0x66, fixed('changeBolusReminderEnable', 7)],
  [0x67, fixed('changeBolusReminderTime', 9)],
  [0x68, fixed('deleteBolusReminderTime', 9)],
  [0x69, (m) => ({ name: 'bolusReminder', length: isLargerModel(m) ? 9 : 7, timestampOffset: 2 })],
  [0x6a, fixed('deleteAlarmClockTime', 7)],
  [0x6c, fixed('dailyTotal515', 38, null)],
  [0x6d, fixed('dailyTotal522', 44, null)],
  [0x6e, fixed('dailyTotal523', 52, null)],
  [0x6f, fixed('changeCarbUnits', 7)],
  [0x7b, fixed('basalProfileStart', 10)],
  [0x7c, fixed('changeWatchdogEnable', 7)],
  [0x7d, fixed('changeOtherDeviceID', 37)],
  [0x81, fixed('changeWatchdogMarriageProfile', 12)],
  [0x82, fixed('deleteOtherDeviceID', 12)],
  [0x83, fixed('changeCaptureEventEnable', 7)],
]);

/** The layout of a record, or null when the type byte is not a known pump event type. */
export const eventLayout = (type: number, model: PumpModel): EventLayout | null => TABLE.get(type)?.(model) ?? null;

export const EventType = {
  bolusNormal: 0x01,
  prime: 0x03,
  alarmPump: 0x06,
  clearAlarm: 0x0c,
  tempBasalDuration: 0x16,
  changeTime: 0x17,
  newTime: 0x18,
  suspend: 0x1e,
  resume: 0x1f,
  rewind: 0x21,
  tempBasal: 0x33,
  unabsorbedInsulin: 0x5c,
  basalProfileStart: 0x7b,
} as const;
