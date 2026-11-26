/**
 * RileyLink radio bridge: a TypeScript port of RileyLinkKit's `RileyLinkBLEKit`
 * (MIT License, (c) Pete Schwamb).
 */
export { RileyLinkDevice, scanRileyLinks, type RileyLinkAdvertisement, type RileyLinkOptions, type SendAndListenOptions, type PacketRadio } from './device';
export { RileyLinkError, isRileyLinkError, type RileyLinkErrorKind } from './errors';
export {
  RILEYLINK_SERVICE_UUID,
  RL_CHAR,
  CC111XRegister,
  SoftwareEncodingType,
  RegisterModeType,
  RileyLinkLedMode,
  RileyLinkLedType,
  RxFilterMode,
  ResponseCode,
  CMD,
  type CC111XRegisterAddress,
} from './constants';
export {
  parseBleFirmware,
  parseRadioFirmware,
  radioCapabilities,
  responseFraming,
  UNKNOWN_FIRMWARE,
  type FirmwareVersion,
  type RadioCapabilities,
  type ResponseFraming,
} from './firmware';
export { decodeRfPacket, encodeRfPacket, type RFPacket } from './rf-packet';
export type { RileyLinkStatistics } from './responses';
export type { RegisterSetting } from './commands';
export { RileyLinkSimulator, type RileyLinkSimulatorOptions, type RadioResponder } from './simulator';
