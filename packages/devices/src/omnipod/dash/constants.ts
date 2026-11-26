/**
 * DASH BLE profile. Port of `Bluetooth/BluetoothServices.swift` and `Bluetooth/BlePodProfile.swift`
 * from OmnipodKit (MIT License, (c) LoopKit Authors). UUIDs are lower case 128-bit strings.
 */

export const DASH_ADVERTISEMENT_UUID = '00004024-0000-1000-8000-00805f9b34fb';
export const DASH_SERVICE_UUID = '1a7e4024-e3ed-4464-8b7e-751e03d0dc5f';
export const DASH_COMMAND_CHARACTERISTIC = '1a7e2441-e3ed-4464-8b7e-751e03d0dc5f';
export const DASH_DATA_CHARACTERISTIC = '1a7e2442-e3ed-4464-8b7e-751e03d0dc5f';

/** Flow control bytes written to / notified on the command characteristic. */
export const PodCommand = {
  RTS: 0x00,
  CTS: 0x01,
  NACK: 0x02,
  ABORT: 0x03,
  SUCCESS: 0x04,
  FAIL: 0x05,
  HELLO: 0x06,
  INCORRECT: 0x09,
} as const;
export type PodCommand = (typeof PodCommand)[keyof typeof PodCommand];

export const DASH_PACKET_LAYOUT = {
  maxPayloadSize: 20,
  maxFragments: 15,
  firstPacketHeaderSizeWithoutMiddlePackets: 7,
  firstPacketHeaderSizeWithMiddlePackets: 2,
  lastPacketHeaderSize: 6,
} as const;
export type PacketLayout = typeof DASH_PACKET_LAYOUT;

/** Address a pod answers to before it is paired. */
export const POD_ID_NOT_ACTIVATED = 0xfffffffe;

/** Pod message prefix/suffix inside the encrypted payload. */
export const COMMAND_PREFIX = 'S0.0=';
export const COMMAND_SUFFIX = ',G0.0';
export const RESPONSE_PREFIX = '0.0=';

/** DASH controller ids start with this byte (`PodType.topIdByte`). */
export const DASH_TOP_ID_BYTE = 0x17;
