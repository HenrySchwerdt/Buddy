/**
 * TypeScript port of `Messages/PacketType.swift` and `Messages/MessageType.swift` from MinimedKit
 * (migrated from ps2/rileylink_ios, MIT License, (c) LoopKit Authors): the packet types and the
 * command / response codes of the Medtronic RF protocol.
 */

export const PacketType = {
  mySentry: 0xa2,
  meter: 0xa5,
  carelink: 0xa7,
  sensor: 0xa8,
} as const;
export type PacketTypeValue = (typeof PacketType)[keyof typeof PacketType];
export const isPacketType = (b: number): b is PacketTypeValue => Object.values(PacketType).includes(b as PacketTypeValue);

export const MessageType = {
  alert: 0x01,
  alertCleared: 0x02,
  deviceTest: 0x03,
  mySentryPumpStatus: 0x04,
  pumpAck: 0x06,
  pumpBackfill: 0x08,
  findDevice: 0x09,
  deviceLink: 0x0a,
  errorResponse: 0x15,
  writeGlucoseHistoryTimestamp: 0x28,
  setBasalProfileA: 0x30,
  setBasalProfileB: 0x31,
  changeTime: 0x40,
  setMaxBolus: 0x41,
  bolus: 0x42,
  pumpExperimentOp67: 0x43,
  pumpExperimentOp68: 0x44,
  pumpExperimentOp69: 0x45,
  selectBasalProfile: 0x4a,
  changeTempBasal: 0x4c,
  suspendResume: 0x4d,
  pumpExperimentOp80: 0x50,
  setRemoteControlId: 0x51,
  pumpExperimentOp82: 0x52,
  setLanguage: 0x53,
  pumpExperimentOp84: 0x54,
  pumpExperimentOp85: 0x55,
  pumpExperimentOp86: 0x56,
  setRemoteControlEnabled: 0x57,
  pumpExperimentOp88: 0x58,
  pumpExperimentOp89: 0x59,
  pumpExperimentOp90: 0x5a,
  buttonPress: 0x5b,
  pumpExperimentOp92: 0x5c,
  powerOn: 0x5d,
  setBolusWizardEnabled1: 0x61,
  setBolusWizardEnabled2: 0x62,
  setBolusWizardEnabled3: 0x63,
  setBolusWizardEnabled4: 0x64,
  setBolusWizardEnabled5: 0x65,
  setAlarmClockEnable: 0x67,
  setMaxBasalRate: 0x6e,
  setBasalProfileStandard: 0x6f,
  readTime: 0x70,
  getBattery: 0x72,
  readRemainingInsulin: 0x73,
  readFirmwareVersion: 0x74,
  readErrorStatus: 0x75,
  readRemoteControlIds: 0x76,
  getHistoryPage: 0x80,
  getPumpModel: 0x8d,
  readProfileStd512: 0x92,
  readProfileA512: 0x93,
  readProfileB512: 0x94,
  readTempBasal: 0x98,
  getGlucosePage: 0x9a,
  readCurrentPageNumber: 0x9d,
  readSettings: 0xc0,
  readCurrentGlucosePage: 0xcd,
  readPumpStatus: 0xce,
  unknownE2: 0xe2,
  unknownE6: 0xe6,
  settingsChangeCounter: 0xec,
  readOtherDevicesIds: 0xf0,
  readCaptureEventEnabled: 0xf1,
  changeCaptureEventEnable: 0xf2,
  readOtherDevicesStatus: 0xf3,
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

const KNOWN_MESSAGE_TYPES: ReadonlySet<number> = new Set(Object.values(MessageType));
export const isMessageType = (b: number): b is MessageTypeValue => KNOWN_MESSAGE_TYPES.has(b);

const NAMES = new Map<number, string>(Object.entries(MessageType).map(([name, code]) => [code, name]));
/** For logs: the name of a message type (never its payload). */
export const messageTypeName = (code: number): string => NAMES.get(code) ?? `0x${code.toString(16)}`;
