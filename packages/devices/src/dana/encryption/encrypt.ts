/**
 * TypeScript port of DanaKit/Encryption/DanaKitEncryption+Encrypt.swift
 * from loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 */
import type { Bytes } from '@buddy/core';
import { DanaPacketType } from '../packet-type';
import { deviceNameBytes, encodePacketPassKey, encodePacketPassKeySerialNumber, encodePacketPassword, encodePacketSerialNumber, encodePacketTime, swapNibbles, u8 } from './common';
import { generateCrc } from './crc';
import { secondLvlEncryptionLookup, timeInformationEnhancedEncryption2Lookup } from './tables';

export interface EncryptParams {
  readonly operationCode: number;
  readonly data: Bytes | null;
  readonly deviceName: string;
  readonly enhancedEncryption: number;
  readonly timeSecret: Bytes;
  readonly passwordSecret: Bytes;
  readonly passKeySecret: Bytes;
}

export interface EncryptResult {
  readonly data: Bytes;
  readonly isEncryptionMode: boolean;
}

export function encrypt(options: EncryptParams): EncryptResult {
  switch (options.operationCode) {
    // DANAR_PACKET__OPCODE_ENCRYPTION__PUMP_CHECK
    case 0x00:
      return encodePumpCheckCommand(options.deviceName, options.enhancedEncryption);

    // DANAR_PACKET__OPCODE_ENCRYPTION__TIME_INFORMATION
    case 0x01:
      return encodeTimeInformation(options.data, options.deviceName, options.enhancedEncryption);

    // DANAR_PACKET__OPCODE_ENCRYPTION__CHECK_PASSKEY
    case 0xd0:
      return encodeCheckPassKeyCommand(options.data, options.deviceName, options.enhancedEncryption);

    // DANAR_PACKET__OPCODE_ENCRYPTION__PASSKEY_REQUEST
    case 0xd1:
    // DANAR_PACKET__OPCODE_ENCRYPTION__GET_PUMP_CHECK
    case 0xf3:
    // DANAR_PACKET__OPCODE_ENCRYPTION__GET_EASYMENU_CHECK
    case 0xf4:
      return encodeRequestCommand(options.operationCode, options.deviceName, options.enhancedEncryption);

    default:
      return encodeDefault(options);
  }
}

export interface SecondLevelParams {
  readonly buffer: Bytes;
  readonly enhancedEncryption: number;
  readonly pairingKey: Bytes;
  readonly randomPairingKey: Bytes;
  readonly randomSyncKey: number;
  readonly bleRandomKeys: readonly [number, number, number];
}

export interface SecondLevelResult {
  readonly randomSyncKey: number;
  readonly buffer: Bytes;
}

const lookup = (i: number | undefined): number => secondLvlEncryptionLookup[i ?? 0] ?? 0;

export function encryptSecondLevel(params: SecondLevelParams): SecondLevelResult {
  const buf = params.buffer.slice();
  const pk = (i: number) => params.pairingKey[i] ?? 0;
  const rpk = (i: number) => params.randomPairingKey[i];
  let updatedRandomSyncKey = params.randomSyncKey;
  const n = buf.length;

  if (params.enhancedEncryption === 1) {
    if (buf[0] === 0xa5 && buf[1] === 0xa5) {
      buf[0] = 0x7a;
      buf[1] = 0x7a;
    }

    if (buf[n - 2] === 0x5a && buf[n - 1] === 0x5a) {
      buf[n - 2] = 0x2e;
      buf[n - 1] = 0x2e;
    }

    for (let i = 0; i < n; i++) {
      let b = buf[i]!;
      b = u8(b ^ pk(0));
      b = u8(b - updatedRandomSyncKey);
      b = swapNibbles(b);

      b = u8(b + pk(1));
      b = u8(b ^ pk(2));
      b = swapNibbles(b);

      b = u8(b - pk(3));
      b = u8(b ^ pk(4));
      b = swapNibbles(b);

      b = u8(b ^ pk(5));
      b = u8(b ^ updatedRandomSyncKey);

      b = u8(b ^ lookup(pk(0)));
      b = u8(b + lookup(pk(1)));
      b = u8(b - lookup(pk(2)));
      b = swapNibbles(b);

      b = u8(b ^ lookup(pk(3)));
      b = u8(b + lookup(pk(4)));
      b = u8(b - lookup(pk(5)));
      b = swapNibbles(b);

      b = u8(b ^ lookup(rpk(0)));
      b = u8(b + lookup(rpk(1)));
      b = u8(b - lookup(rpk(2)));

      buf[i] = b;
      updatedRandomSyncKey = b;
    }
  } else if (params.enhancedEncryption === 2) {
    if (buf[0] === 0xa5 && buf[1] === 0xa5) {
      buf[0] = 0xaa;
      buf[1] = 0xaa;
    }

    if (buf[n - 2] === 0x5a && buf[n - 1] === 0x5a) {
      buf[n - 2] = 0xee;
      buf[n - 1] = 0xee;
    }

    const [k0, k1, k2] = params.bleRandomKeys;
    for (let i = 0; i < n; i++) {
      let b = buf[i]!;
      b = u8(b + k0);
      b = swapNibbles(b);

      b = u8(b - k1);
      b = u8(b ^ k2);
      buf[i] = b;
    }
  }

  return { randomSyncKey: updatedRandomSyncKey, buffer: buf };
}

const crcBytes = (crc: number): [number, number] => [(crc >> 8) & 0xff, crc & 0xff];

export function encodePumpCheckCommand(deviceName: string, enhancedEncryption: number): EncryptResult {
  const buffer = new Uint8Array(19);
  buffer[0] = 0xa5; // header 1
  buffer[1] = 0xa5; // header 2
  buffer[2] = 0x0c; // length
  buffer[3] = DanaPacketType.TYPE_ENCRYPTION_REQUEST;
  buffer[4] = 0x00; // pump_check command

  // Device name
  const name = deviceNameBytes(deviceName);
  for (let i = 0; i < 10; i++) buffer[5 + i] = name[i]!;

  const [c1, c2] = crcBytes(generateCrc(buffer.subarray(3, 15), enhancedEncryption, true));
  buffer[15] = c1; // crc 1
  buffer[16] = c2; // crc 2

  buffer[17] = 0x5a; // footer 1
  buffer[18] = 0x5a; // footer 2

  return { data: encodePacketSerialNumber(buffer, deviceName), isEncryptionMode: true };
}

export function encodeRequestCommand(operationCode: number, deviceName: string, enhancedEncryption: number): EncryptResult {
  const buffer = new Uint8Array(9);
  buffer[0] = 0xa5; // header 1
  buffer[1] = 0xa5; // header 2
  buffer[2] = 0x02; // length
  buffer[3] = DanaPacketType.TYPE_ENCRYPTION_REQUEST;
  buffer[4] = operationCode;

  const [c1, c2] = crcBytes(generateCrc(buffer.subarray(3, 5), enhancedEncryption, true));
  buffer[5] = c1; // crc 1
  buffer[6] = c2; // crc 2
  buffer[7] = 0x5a; // footer 1
  buffer[8] = 0x5a; // footer 2

  return { data: encodePacketSerialNumber(buffer, deviceName), isEncryptionMode: true };
}

export function encodeTimeInformation(data: Bytes | null, deviceName: string, enhancedEncryption: number): EncryptResult {
  const lengthOfData = data?.length ?? 0;
  const buffer = new Uint8Array(9 + lengthOfData);
  buffer[0] = 0xa5; // header 1
  buffer[1] = 0xa5; // header 2
  buffer[2] = u8(0x02 + lengthOfData); // length
  buffer[3] = DanaPacketType.TYPE_ENCRYPTION_REQUEST;
  buffer[4] = 0x01; // time information command

  if (data && data.length > 0) {
    /* Original code:
     if (enhancedEncryption === 2) {
     data[1] = 0x17 ^ 0x1a;
     data[2] = 0xd1 ^ 0xc0;
     data[3] = 0xaf ^ 0xa9;
     }
     */
    for (let i = 0; i < data.length; i++) {
      buffer[5 + i] = enhancedEncryption === 2 && i > 0 && i < 4 ? timeInformationEnhancedEncryption2Lookup[i]! : data[i]!;
    }
  }

  const [c1, c2] = crcBytes(generateCrc(buffer.subarray(3, 5 + lengthOfData), enhancedEncryption, true));
  buffer[5 + lengthOfData] = c1; // crc 1
  buffer[6 + lengthOfData] = c2; // crc 2
  buffer[7 + lengthOfData] = 0x5a; // footer 1
  buffer[8 + lengthOfData] = 0x5a; // footer 2

  return { data: encodePacketSerialNumber(buffer, deviceName), isEncryptionMode: true };
}

export function encodeCheckPassKeyCommand(data: Bytes | null, deviceName: string, enhancedEncryption: number): EncryptResult {
  const lengthOfData = data?.length ?? 0;
  const buffer = new Uint8Array(9 + lengthOfData);
  buffer[0] = 0xa5; // header 1
  buffer[1] = 0xa5; // header 2
  buffer[2] = u8(0x02 + lengthOfData); // length
  buffer[3] = DanaPacketType.TYPE_ENCRYPTION_REQUEST;
  buffer[4] = 0xd0; // check passkey command

  if (data && data.length > 0) {
    for (let i = 0; i < data.length; i++) buffer[5 + i] = encodePacketPassKeySerialNumber(data[i]!, deviceName);
  }

  const [c1, c2] = crcBytes(generateCrc(buffer.subarray(3, 5 + lengthOfData), enhancedEncryption, true));
  buffer[5 + lengthOfData] = c1; // crc 1
  buffer[6 + lengthOfData] = c2; // crc 2
  buffer[7 + lengthOfData] = 0x5a; // footer 1
  buffer[8 + lengthOfData] = 0x5a; // footer 2

  return { data: encodePacketSerialNumber(buffer, deviceName), isEncryptionMode: true };
}

export function encodeDefault(options: EncryptParams): EncryptResult {
  const lengthOfData = options.data?.length ?? 0;
  const buffer = new Uint8Array(9 + lengthOfData);
  buffer[0] = 0xa5; // header 1
  buffer[1] = 0xa5; // header 2
  buffer[2] = u8(0x02 + lengthOfData); // length
  buffer[3] = DanaPacketType.TYPE_COMMAND;
  buffer[4] = options.operationCode; // operation code

  if (options.data && lengthOfData > 0) buffer.set(options.data, 5);

  const [c1, c2] = crcBytes(generateCrc(buffer.subarray(3, 5 + lengthOfData), options.enhancedEncryption, false));
  buffer[5 + lengthOfData] = c1; // crc 1
  buffer[6 + lengthOfData] = c2; // crc 2
  buffer[7 + lengthOfData] = 0x5a; // footer 1
  buffer[8 + lengthOfData] = 0x5a; // footer 2

  let encrypted1 = encodePacketSerialNumber(buffer, options.deviceName);
  if (options.enhancedEncryption === 0) {
    encrypted1 = encodePacketTime(encrypted1, options.timeSecret);
    encrypted1 = encodePacketPassword(encrypted1, options.passwordSecret);
    encrypted1 = encodePacketPassKey(encrypted1, options.passKeySecret);
  }

  return { data: encrypted1, isEncryptionMode: false };
}
