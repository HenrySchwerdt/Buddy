/**
 * TypeScript port of `BLEFirmwareVersion.swift` and `RadioFirmwareVersion.swift` from RileyLinkBLEKit
 * (RileyLinkKit, MIT License, (c) Pete Schwamb).
 */

export interface FirmwareVersion {
  readonly components: readonly number[];
  readonly versionString: string;
}

const parseVersion = (prefix: string, versionString: string): FirmwareVersion | null => {
  if (!versionString.startsWith(prefix)) return null;
  const components = versionString
    .slice(prefix.length)
    .split('.')
    .filter((s) => s !== '')
    .map((s) => (/^[+-]?\d+$/.test(s) ? parseInt(s, 10) : NaN))
    .filter((n) => !Number.isNaN(n));
  return { components, versionString };
};

export const UNKNOWN_FIRMWARE: FirmwareVersion = { components: [0], versionString: 'Unknown' };

/** "ble_rfspy 2.0" - the BLE chip firmware. */
export const parseBleFirmware = (s: string): FirmwareVersion | null => parseVersion('ble_rfspy ', s);
/** "subg_rfspy 2.2" - the CC1110 radio firmware. */
export const parseRadioFirmware = (s: string): FirmwareVersion | null => parseVersion('subg_rfspy ', s);

export const isUnknownFirmware = (v: FirmwareVersion): boolean => v.components.length === 1 && v.components[0] === 0;

/** BLE firmware >= 2 delivers one response per notification; older firmware streams a 0x00-delimited buffer. */
export type ResponseFraming = 'single' | 'buffered';
export const responseFraming = (ble: FirmwareVersion | null): ResponseFraming => ((ble?.components[0] ?? 0) >= 2 ? 'single' : 'buffered');

const major = (v: FirmwareVersion) => v.components[0] ?? 0;
const atLeastV2 = (v: FirmwareVersion) => major(v) >= 2;
const atLeastV2_2 = (v: FirmwareVersion) => {
  if (v.components.length < 2) return false;
  const [ma, mi] = [v.components[0]!, v.components[1]!];
  return ma > 2 || (ma === 2 && mi >= 2);
};

/** Capability flags derived from the radio (subg_rfspy) firmware version. */
export interface RadioCapabilities {
  readonly supportsPreambleExtension: boolean;
  readonly supportsSoftwareEncoding: boolean;
  readonly supportsResetRadioConfig: boolean;
  readonly supports16BitPacketDelay: boolean;
  readonly needsExtraByteForUpdateRegister: boolean;
  readonly needsExtraByteForReadRegister: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsCustomPreamble: boolean;
  readonly supportsReadRegister: boolean;
}

export function radioCapabilities(v: FirmwareVersion): RadioCapabilities {
  const v2 = atLeastV2(v);
  const needsExtraRead = v.components.length < 2 ? true : major(v) < 2 || (major(v) === 2 && v.components[1]! <= 2);
  return {
    supportsPreambleExtension: v2,
    supportsSoftwareEncoding: v2,
    supportsResetRadioConfig: v2,
    supports16BitPacketDelay: v2,
    needsExtraByteForUpdateRegister: !v2, // fixed in 2.2 per RileyLinkKit, which keys it on v2
    needsExtraByteForReadRegister: needsExtraRead, // fixed in 2.3
    supportsStatistics: atLeastV2_2(v),
    supportsCustomPreamble: v2,
    supportsReadRegister: v2,
  };
}
