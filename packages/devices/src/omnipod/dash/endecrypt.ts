/**
 * Port of `Bluetooth/EnDecrypt/Nonce.swift` and `EnDecrypt.swift` from OmnipodKit (MIT License,
 * (c) LoopKit Authors): AES-CCM encryption of message packets with a per-direction nonce.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { aesCcmDecrypt, aesCcmEncrypt } from './crypto';
import { OmnipodError } from './errors';
import { packetHeader, type MessagePacket } from './message-packet';

/** 8 byte session prefix + 5 byte sequence; the top bit of the sequence tells the direction. */
export function nonceFor(prefix: Bytes, sqn: number, podReceiving: boolean): Bytes {
  if (prefix.length !== 8) throw new OmnipodError('protocol', 'Nonce prefix must be 8 bytes');
  const seq = new Uint8Array(5);
  for (let i = 4, v = sqn; i >= 0; i--, v = Math.floor(v / 256)) seq[i] = v & 0xff;
  seq[0] = podReceiving ? seq[0]! & 127 : seq[0]! | 128;
  return concatBytes(prefix, seq);
}

export interface EnDecrypt {
  encrypt(plain: MessagePacket, nonceSeq: number): MessagePacket;
  decrypt(received: MessagePacket, nonceSeq: number): MessagePacket;
}

/**
 * `fromController`: the encrypting side is the controller (so the pod receives); the simulator
 * uses the mirror image.
 */
export function makeEnDecrypt(noncePrefix: Bytes, ck: Bytes, fromController = true): EnDecrypt {
  return {
    encrypt(plain, nonceSeq) {
      const n = nonceFor(noncePrefix, nonceSeq, fromController);
      return { ...plain, payload: aesCcmEncrypt(ck, n, packetHeader(plain, true), plain.payload, 8) };
    },
    decrypt(received, nonceSeq) {
      const n = nonceFor(noncePrefix, nonceSeq, !fromController);
      return { ...received, payload: aesCcmDecrypt(ck, n, packetHeader(received, false), received.payload, 8) };
    },
  };
}
