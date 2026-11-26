/**
 * GATT inventory and protocol constants for the FreeStyle Libre 3 / 3+ direct driver.
 *
 * TypeScript port of RoundWhiteDiscKit (MIT, (c) the RoundWhiteDiscKit authors:
 * `BLE/LibreSensorGATT.swift`, `Pairing/SensorCert.swift`, `DataPlane/DataPlaneCrypto.swift`) and of
 * the constants used by LibreLoop (MIT, (c) the LibreLoop authors).
 *
 * Not an Abbott product. FreeStyle Libre is a trademark of Abbott, used only to name the sensor.
 */
import type { Bytes } from '@buddy/core';

const base = (prefix: string): string => `${prefix}-ef89-11e9-81b4-2a2ae2dbcce4`;

/** Primary data service, used for scanning. */
export const LIBRE3_DATA_SERVICE = base('089810cc');
/** Dedicated security (certificate / challenge) service. */
export const LIBRE3_SECURITY_SERVICE = base('0898203a');

export const LIBRE3_CHAR = {
  // data service
  glucoseData: base('0898177a'),
  patchStatus: base('08981482'),
  patchControl: base('08981338'),
  historicData: base('0898195a'),
  eventLog: base('08981bee'),
  clinicalData: base('08981ab8'),
  factoryData: base('08981d24'),
  // security service
  certData: base('089823fa'),
  challengeData: base('089822ce'),
  commandResponse: base('08982198'),
} as const;

export type Libre3DataChannel = 'patchControl' | 'patchStatus' | 'glucoseData' | 'historicData' | 'eventLog' | 'clinicalData' | 'factoryData';

/** Data-plane characteristics enabled right after Phase 6 (RoundWhiteDiscKit `dataPlaneNotifying` plus the backfill pair). */
export const DATA_PLANE_CHANNELS: readonly Libre3DataChannel[] = [
  'patchControl',
  'eventLog',
  'factoryData',
  'glucoseData',
  'patchStatus',
  'historicData',
  'clinicalData',
];

/** Phone-to-sensor write fragments carry a 2-byte LE offset plus up to 18 payload bytes. */
export const WRITE_CHUNK_PAYLOAD = 18;

/** Security command bytes (phone to sensor, `secCommandResponse`). */
export const SEC_CMD = {
  startAuthentication: 0x01,
  loadCertificate: 0x02,
  certificateLoadDone: 0x03,
  getCertificate: 0x09,
  validateCertificate: 0x0d,
  ephemeralDone: 0x0e,
  startAuthorization: 0x11,
  challengeLoadDone: 0x08,
} as const;

/** Expected sensor response prefixes on `secCommandResponse`. */
export const SEC_RESPONSE = {
  certificateAccepted: 0x04,
  certificateReady: 0x0a,
  ephemeralReady: 0x0f,
  challengeLoadDone: 0x08,
} as const;

export const PHONE_CERT_SIZE = 162;
export const PHONE_CERT_PUBKEY_OFFSET = 33;
export const SENSOR_CERT_SIZE = 140;
export const PHASE5_WIRE_SIZE = 54;
export const PHASE6_WIRE_SIZE = 67;
export const CHALLENGE_NOTIFY_SIZE = 23;
export const EPHEMERAL_WRITE_SIZE = 72;
export const CCM_TAG_SIZE = 4;

/**
 * Abbott patch-signing public keys (65-byte uncompressed P-256 points). These are public verifier
 * keys published in the RoundWhiteDiscKit sources, used to check the sensor certificate. They
 * are not secrets and not credentials.
 */
export const PATCH_SIGNING_KEYS: readonly Bytes[] = [
  Uint8Array.from([
    0x04, 0xb6, 0x9d, 0x17, 0x34, 0xf5, 0xe4, 0x25, 0xbc, 0xc0, 0x57, 0x6a, 0xd1, 0xf7, 0x27, 0xc1, 0x31, 0x1c, 0x90, 0xb6, 0xea, 0x98, 0x6f, 0x00,
    0x6e, 0x7e, 0x9f, 0x90, 0x96, 0xf6, 0xa8, 0x28, 0x4f, 0x12, 0xbf, 0x7d, 0xdf, 0xe1, 0x54, 0xa3, 0xf1, 0xd4, 0x5a, 0x0f, 0x27, 0x34, 0xec, 0xab,
    0xca, 0x6b, 0x9e, 0xb5, 0x6e, 0xe4, 0xec, 0xca, 0x87, 0x85, 0x3a, 0xd8, 0x53, 0xb6, 0xa6, 0x41, 0x80,
  ]),
  Uint8Array.from([
    0x04, 0xa2, 0xd8, 0x47, 0x89, 0x90, 0x94, 0x5f, 0x70, 0xa9, 0x57, 0x0a, 0xde, 0x07, 0xb1, 0x55, 0xbc, 0x90, 0x4d, 0x2d, 0x38, 0x06, 0x47, 0x58,
    0x7b, 0x12, 0x39, 0x17, 0x01, 0x30, 0x9b, 0xd1, 0x0b, 0x59, 0x90, 0xc4, 0xc4, 0x7c, 0x47, 0xf1, 0xf0, 0x80, 0x46, 0xcb, 0x6f, 0x2d, 0xe0, 0x74,
    0x8d, 0x1f, 0xa7, 0xf7, 0x37, 0x90, 0xec, 0x9d, 0x8d, 0xd6, 0x37, 0x21, 0x27, 0x78, 0x52, 0x88, 0x38,
  ]),
];

export const LIBRE3_ID = 'libre-3-direct';
