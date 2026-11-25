/**
 * TypeScript port of DanaKit/Encryption/DanaKitEncryption+Decrypt.swift
 * from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 */
import type { Bytes } from '@buddy/core';
import { encodePacketPassKey, encodePacketPassKeySerialNumber, encodePacketPassword, encodePacketSerialNumber, encodePacketTime, swapNibbles, u8 } from './common';
import { generateCrc } from './crc';
import type { SecondLevelParams, SecondLevelResult } from './encrypt';
import { secondLvlEncryptionLookup } from './tables';

export interface DecryptParam {
  readonly data: Bytes;
  readonly deviceName: string;
  readonly enhancedEncryption: number;
  readonly isEncryptionMode: boolean;
  readonly pairingKeyLength: number;
  readonly randomPairingKeyLength: number;
  readonly ble5KeyLength: number;
  readonly timeSecret: Bytes;
  readonly passwordSecret: Bytes;
  readonly passKeySecret: Bytes;
  readonly passKeySecretBackup: Bytes;
}

export interface DecryptReturn {
  readonly data: Bytes;
  readonly isEncryptionMode: boolean;
  readonly timeSecret: Bytes;
  readonly passwordSecret: Bytes;
  readonly passKeySecret: Bytes;
  readonly passKeySecretBackup: Bytes;
}

export class DanaDecryptError extends Error {}

/** Throws `DanaDecryptError` (Swift: NSError) on a length or CRC mismatch. */
export function decrypt(options: DecryptParam): DecryptReturn {
  let data = encodePacketSerialNumber(options.data, options.deviceName);
  let { isEncryptionMode, timeSecret, passwordSecret, passKeySecret, passKeySecretBackup } = options;

  if (!options.isEncryptionMode && options.enhancedEncryption === 0) {
    data = encodePacketTime(data, options.timeSecret);
    data = encodePacketPassword(data, options.passwordSecret);
    data = encodePacketPassKey(data, options.passKeySecret);
  }

  if (data.length < 7 || data[2] !== data.length - 7) {
    throw new DanaDecryptError('Package length does not match the length attr.');
  }

  const content = data.slice(3, data.length - 4);
  const crc = generateCrc(content, options.enhancedEncryption, options.isEncryptionMode);

  if (crc >> 8 !== data[data.length - 4] || (crc & 0xff) !== data[data.length - 3]) {
    throw new DanaDecryptError('Crc checksum failed...');
  }

  if (content[0] === 0x2 && content[1] === 0xd0 && content[2] === 0x0) {
    // Response for DANAR_PACKET__OPCODE_ENCRYPTION__CHECK_PASSKEY
    passKeySecret = passKeySecretBackup;
  }

  if (content[0] === 0x2 && content[1] === 0xd2 && content.length >= 4) {
    // Response for ??
    passKeySecret = new Uint8Array([content[2]!, content[3]!]);
    passKeySecretBackup = new Uint8Array([content[2]!, content[3]!]);

    content[2] = encodePacketPassKeySerialNumber(content[2]!, options.deviceName);
    content[3] = encodePacketPassKeySerialNumber(content[3]!, options.deviceName);
  }

  if (content[0] === 0x2 && content[1] === 0x1) {
    // Response for DANAR_PACKET__OPCODE_ENCRYPTION__TIME_INFORMATION
    if (options.enhancedEncryption === 1) {
      isEncryptionMode = options.pairingKeyLength === 0 && options.randomPairingKeyLength === 0;
    } else if (options.enhancedEncryption === 2) {
      isEncryptionMode = options.ble5KeyLength === 0;
    } else {
      // The initial message
      if (data.length !== 0x11) {
        throw new DanaDecryptError('Invalid length for TIME_INFORMATION');
      }

      isEncryptionMode = false;
      timeSecret = content.slice(2, 8);

      passwordSecret = content.slice(8, 10);
      passwordSecret[0] = u8(passwordSecret[0]! ^ 0x87);
      passwordSecret[1] = u8(passwordSecret[1]! ^ 0x0d);
    }
  }

  return { data: content, isEncryptionMode, timeSecret, passwordSecret, passKeySecret, passKeySecretBackup };
}

const lookup = (i: number | undefined): number => secondLvlEncryptionLookup[i ?? 0] ?? 0;

export function decryptSecondLevel(params: SecondLevelParams): SecondLevelResult {
  const buf = params.buffer.slice();
  const pk = (i: number) => params.pairingKey[i] ?? 0;
  const rpk = (i: number) => params.randomPairingKey[i];
  let randomSyncKey = params.randomSyncKey;
  const n = buf.length;

  if (params.enhancedEncryption === 1) {
    for (let i = 0; i < n; i++) {
      const copyRandomSyncKey = buf[i]!;
      let b = buf[i]!;

      b = u8(b + lookup(rpk(2)));
      b = u8(b - lookup(rpk(1)));
      b = u8(b ^ lookup(rpk(0)));
      b = swapNibbles(b);

      b = u8(b + lookup(pk(5)));
      b = u8(b - lookup(pk(4)));
      b = u8(b ^ lookup(pk(3)));
      b = swapNibbles(b);

      b = u8(b + lookup(pk(2)));
      b = u8(b - lookup(pk(1)));
      b = u8(b ^ lookup(pk(0)));
      b = u8(b ^ randomSyncKey);
      b = u8(b ^ pk(5));

      b = swapNibbles(b);
      b = u8(b ^ pk(4));
      b = u8(b + pk(3));

      b = swapNibbles(b);
      b = u8(b ^ pk(2));
      b = u8(b - pk(1));

      b = swapNibbles(b);
      b = u8(b + randomSyncKey);
      b = u8(b ^ pk(0));

      buf[i] = b;
      randomSyncKey = copyRandomSyncKey;
    }

    if (buf[0] === 0x7a && buf[1] === 0x7a) {
      buf[0] = 0xa5;
      buf[1] = 0xa5;
    }

    if (buf[n - 2] === 0x2e && buf[n - 1] === 0x2e) {
      buf[n - 2] = 0x5a;
      buf[n - 1] = 0x5a;
    }
  } else if (params.enhancedEncryption === 2) {
    const [k0, k1, k2] = params.bleRandomKeys;
    for (let i = 0; i < n; i++) {
      let b = buf[i]!;
      b = u8(b ^ k2);
      b = u8(b + k1);

      b = swapNibbles(b);
      b = u8(b - k0);
      buf[i] = b;
    }
  }

  return { randomSyncKey, buffer: buf };
}
