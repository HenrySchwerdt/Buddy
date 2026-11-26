/**
 * TypeScript port of the BLE/command constants of `RileyLinkBLEKit`
 * (`PeripheralManager+RileyLink.swift`, `Command.swift`, `Response.swift`, `CommandSession.swift`)
 * from RileyLinkKit (MIT License, (c) Pete Schwamb).
 */

/** Lower-case 128-bit service / characteristic UUIDs, as the BleTransport expects them. */
export const RILEYLINK_SERVICE_UUID = '0235733b-99c5-4197-b856-69219c2a3845';
export const RILEYLINK_BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';

export const RL_CHAR = {
  data: 'c842e849-5028-42e2-867c-016adada9155',
  responseCount: '6e6c7910-b89e-43a5-a0fe-50c5e2b81f4a',
  customName: 'd93b2af0-1e28-11e4-8c21-0800200c9a66',
  timerTick: '6e6c7910-b89e-43a5-78af-50c5e2b86f7e',
  firmwareVersion: '30d99dc9-7c91-4295-a051-0a104d238cf2',
  ledMode: 'c6d84241-f1a7-4f9c-a25f-fce16732f14e',
} as const;

export const RL_BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

/** Maximum length of one command frame (excluding the length prefix byte). */
export const MAX_COMMAND_LENGTH = 220;

/** Slack added to every command timeout for BLE round trips (`expectedMaxBLELatency`). */
export const EXPECTED_MAX_BLE_LATENCY_MS = 2000;

/** Command codes ("CmdBase") understood by subg_rfspy. */
export const CMD = {
  getState: 1,
  getVersion: 2,
  getPacket: 3,
  sendPacket: 4,
  sendAndListen: 5,
  updateRegister: 6,
  reset: 7,
  setLEDMode: 8,
  readRegister: 9,
  setModeRegisters: 10,
  setSWEncoding: 11,
  setPreamble: 12,
  resetRadioConfig: 13,
  getStatistics: 14,
} as const;

export type CommandCode = (typeof CMD)[keyof typeof CMD];

export const ResponseCode = {
  rxTimeout: 0xaa,
  commandInterrupted: 0xbb,
  zeroData: 0xcc,
  success: 0xdd,
  invalidParam: 0x11,
  unknownCommand: 0x22,
} as const;

export type ResponseCodeValue = (typeof ResponseCode)[keyof typeof ResponseCode];

const RESPONSE_CODES: ReadonlySet<number> = new Set(Object.values(ResponseCode));
export const isResponseCode = (b: number): b is ResponseCodeValue => RESPONSE_CODES.has(b);

export const RileyLinkLedType = { green: 0, blue: 1 } as const;
export const RileyLinkLedMode = { off: 0, on: 1, auto: 2 } as const;
export type RileyLinkLedModeValue = (typeof RileyLinkLedMode)[keyof typeof RileyLinkLedMode];

export const RxFilterMode = { wide: 0x50, narrow: 0x90 } as const;

export const SoftwareEncodingType = { none: 0, manchester: 1, fourbsixb: 2 } as const;
export type SoftwareEncodingValue = (typeof SoftwareEncodingType)[keyof typeof SoftwareEncodingType];

export const RegisterModeType = { tx: 0x01, rx: 0x02 } as const;
export type RegisterModeValue = (typeof RegisterModeType)[keyof typeof RegisterModeType];

/** CC111x register addresses (subg_rfspy `CC111XRegister`). */
export const CC111XRegister = {
  sync1: 0x00,
  sync0: 0x01,
  pktlen: 0x02,
  pktctrl1: 0x03,
  pktctrl0: 0x04,
  fsctrl1: 0x07,
  freq2: 0x09,
  freq1: 0x0a,
  freq0: 0x0b,
  mdmcfg4: 0x0c,
  mdmcfg3: 0x0d,
  mdmcfg2: 0x0e,
  mdmcfg1: 0x0f,
  mdmcfg0: 0x10,
  deviatn: 0x11,
  mcsm0: 0x14,
  foccfg: 0x15,
  agcctrl2: 0x17,
  agcctrl1: 0x18,
  agcctrl0: 0x19,
  frend1: 0x1a,
  frend0: 0x1b,
  fscal3: 0x1c,
  fscal2: 0x1d,
  fscal1: 0x1e,
  fscal0: 0x1f,
  test1: 0x24,
  test0: 0x25,
  paTable0: 0x2e,
} as const;

export type CC111XRegisterAddress = (typeof CC111XRegister)[keyof typeof CC111XRegister];

/** CC1110 crystal frequency used to convert a carrier frequency to FREQ2..0. */
export const XTAL_FREQUENCY_HZ = 24_000_000;
