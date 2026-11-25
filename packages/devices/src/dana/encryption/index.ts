/**
 * TypeScript port of DanaKit/Encryption/DanaKitEncryption.swift
 * from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 *
 * One instance per BLE connection (PeripheralManager creates a fresh encryptor per connection).
 * Note: the random sync key of RSv3 second-level encryption is a single chained value shared by
 * the send and the receive direction, exactly as in DanaKit.
 */
import type { Bytes } from '@buddy/core';
import { EncryptionType } from '../packet-type';
import { decryptionRandomSyncKey, initialRandomSyncKey } from './common';
import { decrypt, decryptSecondLevel } from './decrypt';
import { encrypt, encryptSecondLevel } from './encrypt';
import { secondLvlEncryptionLookupShort } from './tables';

export * from './common';
export { generateCrc } from './crc';
export { decrypt, decryptSecondLevel, DanaDecryptError, type DecryptParam, type DecryptReturn } from './decrypt';
export { encrypt, encryptSecondLevel, type EncryptParams, type EncryptResult, type SecondLevelParams, type SecondLevelResult } from './encrypt';
export { secondLvlEncryptionLookup, secondLvlEncryptionLookupShort } from './tables';

const EMPTY = new Uint8Array(0);

/** Parses the 6 ASCII-digit BLE5 key into the three random keys; `null` if any byte is not a digit. */
export function ble5RandomKeysFrom(ble5Key: Bytes): [number, number, number] | null {
  if (ble5Key.length < 6 || Array.from(ble5Key.subarray(0, 6)).some((b) => b < 0x30 || b > 0x39)) return null;
  const pair = (i: number) => (ble5Key[i]! - 0x30) * 10 + (ble5Key[i + 1]! - 0x30);
  return [secondLvlEncryptionLookupShort[pair(0)]!, secondLvlEncryptionLookupShort[pair(2)]!, secondLvlEncryptionLookupShort[pair(4)]!];
}

export class DanaKitEncryption {
  private enhancedEncryption = 0;
  private isEncryptionMode = true;

  // Length 2
  private passwordSecret: Bytes = EMPTY;

  // Length: 6
  private timeSecret: Bytes = EMPTY;

  // Length: 2
  private passKeySecret: Bytes = EMPTY;
  private passKeySecretBackup: Bytes = EMPTY;

  // Length: 6
  private pairingKey: Bytes = EMPTY;

  // Length: 3
  private randomPairingKey: Bytes = EMPTY;
  private randomSyncKey = 0;

  // Length: 6
  private ble5Key: Bytes = EMPTY;
  private ble5RandomKeys: [number, number, number] = [0, 0, 0];

  isDanaI(): boolean {
    return this.enhancedEncryption === EncryptionType.BLE_5;
  }

  isDanaRS(): boolean {
    return this.enhancedEncryption === EncryptionType.RSv3;
  }

  shouldDoSecondLevel(): boolean {
    return this.enhancedEncryption !== EncryptionType.DEFAULT;
  }

  // Encoding functions -> Encryption in JNI lib
  encodePacket(operationCode: number, buffer: Bytes | null, deviceName: string): Bytes {
    const result = encrypt({
      operationCode,
      data: buffer,
      deviceName,
      enhancedEncryption: this.enhancedEncryption,
      timeSecret: this.timeSecret,
      passwordSecret: this.passwordSecret,
      passKeySecret: this.passKeySecret,
    });

    this.isEncryptionMode = result.isEncryptionMode;
    return result.data;
  }

  encodeSecondLevel(data: Bytes): Bytes {
    const result = encryptSecondLevel({
      buffer: data,
      enhancedEncryption: this.enhancedEncryption,
      pairingKey: this.pairingKey,
      randomPairingKey: this.randomPairingKey,
      randomSyncKey: this.randomSyncKey,
      bleRandomKeys: this.ble5RandomKeys,
    });

    this.randomSyncKey = result.randomSyncKey;
    return result.buffer;
  }

  // Decoding function -> Decrypting in JNI lib. Returns an empty array when decryption fails.
  decodePacket(buffer: Bytes, deviceName: string): Bytes {
    try {
      const result = decrypt({
        data: buffer,
        deviceName,
        enhancedEncryption: this.enhancedEncryption,
        isEncryptionMode: this.isEncryptionMode,
        pairingKeyLength: this.pairingKey.length,
        randomPairingKeyLength: this.randomPairingKey.length,
        ble5KeyLength: this.ble5Key.length,
        timeSecret: this.timeSecret,
        passwordSecret: this.passwordSecret,
        passKeySecret: this.passKeySecret,
        passKeySecretBackup: this.passKeySecretBackup,
      });

      this.isEncryptionMode = result.isEncryptionMode;
      this.timeSecret = result.timeSecret;
      this.passwordSecret = result.passwordSecret;
      this.passKeySecret = result.passKeySecret;
      this.passKeySecretBackup = result.passKeySecretBackup;

      return result.data;
    } catch {
      return EMPTY;
    }
  }

  decodeSecondLevel(data: Bytes): Bytes {
    const result = decryptSecondLevel({
      buffer: data,
      enhancedEncryption: this.enhancedEncryption,
      pairingKey: this.pairingKey,
      randomPairingKey: this.randomPairingKey,
      randomSyncKey: this.randomSyncKey,
      bleRandomKeys: this.ble5RandomKeys,
    });

    this.randomSyncKey = result.randomSyncKey;
    return result.buffer;
  }

  // Setter functions
  setEnhancedEncryption(enhancedEncryption: number): void {
    this.enhancedEncryption = enhancedEncryption;
  }

  /**
   * Swift crashes when `randomSyncKey` is nil and the pairing key is shorter than 6 bytes
   * (DEFAULT-mode pairing); the sync key then stays 0 here. It is unused in DEFAULT mode.
   */
  setPairingKeys(pairingKey: Bytes, randomPairingKey: Bytes, randomSyncKey: number | null): void {
    this.pairingKey = pairingKey.slice();
    this.randomPairingKey = randomPairingKey.slice();

    if (randomSyncKey !== null) {
      this.randomSyncKey = randomPairingKey.length >= 3 ? decryptionRandomSyncKey(randomSyncKey, randomPairingKey) : 0;
    } else {
      this.randomSyncKey = pairingKey.length >= 6 ? initialRandomSyncKey(pairingKey) : 0;
    }
  }

  getPairingKeys(): [Bytes, Bytes] {
    return [this.pairingKey, this.randomPairingKey];
  }

  /** Swift traps on non-digit keys; here they are rejected (returns false) and nothing changes. */
  setBle5Key(ble5Key: Bytes): boolean {
    const keys = ble5RandomKeysFrom(ble5Key);
    if (!keys) return false;
    this.ble5Key = ble5Key.slice();
    this.ble5RandomKeys = keys;
    return true;
  }
}
