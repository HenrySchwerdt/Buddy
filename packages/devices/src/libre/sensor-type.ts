/**
 * TypeScript port of `SensorFamily` / `SensorType` from `Bluetooth/LibreTransmitterMetadata.swift`
 * and of `LibreSensor/SensorContents/SensorState.swift` from loopandlearn/LibreTransmitter
 * (MIT, (c) Uwe Petersen and the LibreTransmitter authors).
 *
 * Note: `libre3` only exists here as a patch-info classification (24-byte patch info). The Swift
 * package has no Libre 3 protocol support and neither does this port.
 */
import type { Bytes } from '@buddy/core';

export const SensorFamily = { libre: 0, librePro: 1, libre2: 3, libreSense: 7 } as const;
export type SensorFamily = (typeof SensorFamily)[keyof typeof SensorFamily];

export function sensorFamilyFromRaw(raw: number): SensorFamily | null {
  return (Object.values(SensorFamily) as number[]).includes(raw) ? (raw as SensorFamily) : null;
}

export type SensorType =
  | 'Libre 1'
  | 'Libre US 14d'
  | 'Libre Pro/H'
  | 'Libre 2'
  | 'Libre 2 US'
  | 'Libre 2 CA'
  | 'Libre Sense'
  | 'Libre 3'
  | 'Dexcom ONE'
  | 'Dexcom G7'
  | 'Libre';

/** `SensorType(patchInfo:)`. */
export function sensorTypeFromPatchInfo(patchInfo: Bytes): SensorType {
  switch (patchInfo[0]) {
    case 0xdf:
    case 0xa2:
      return 'Libre 1';
    case 0xe5:
    case 0xe6:
      return 'Libre US 14d';
    case 0x70:
      return 'Libre Pro/H';
    case 0xc5:
    case 0x9d:
    case 0xc6:
    case 0x7f:
      return 'Libre 2';
    case 0x76:
      if (patchInfo[3] === 0x02) return 'Libre 2 US';
      if (patchInfo[3] === 0x04) return 'Libre 2 CA';
      return (patchInfo[2] ?? 0) >> 4 === 7 ? 'Libre Sense' : 'Libre';
    default:
      return patchInfo.length === 24 ? 'Libre 3' : 'Libre';
  }
}

export type SensorState = 'notYetStarted' | 'starting' | 'ready' | 'expired' | 'shutdown' | 'failure' | 'unknown';

/** `SensorState(stateByte:)`. */
export function sensorStateFromByte(stateByte: number): SensorState {
  switch (stateByte) {
    case 1: return 'notYetStarted';
    case 2: return 'starting';
    case 3: return 'ready';
    case 4: return 'expired';
    case 5: return 'shutdown';
    case 6: return 'failure';
    default: return 'unknown';
  }
}
