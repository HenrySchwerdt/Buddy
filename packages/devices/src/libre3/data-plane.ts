/**
 * Post-authorization data plane: AES-CCM frame crypto (key kEnc, 13-byte nonce
 * `seq_LE2 || descriptor3 || ivEnc8`, 4-byte tag) and channel decoding.
 *
 * TypeScript port of RoundWhiteDiscKit `DataPlane/DataPlaneCrypto.swift` and
 * `DataPlane/DataPlaneDecoder.swift` (MIT, (c) the RoundWhiteDiscKit authors).
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { CcmAuthError, ccmDecrypt, ccmEncrypt } from './ccm';
import { CCM_TAG_SIZE, LIBRE3_CHAR, type Libre3DataChannel } from './constants';
import { encodeDataFrame, type DataFrame } from './framing';
import { decodeClinicalRecord, decodeHistoricalPage, type ClinicalRecord, type HistoricalPage } from './history';
import { decodePatchStatus, type PatchStatus } from './lifecycle';
import { decodeRealtime, type RealtimeGlucose } from './realtime';

/** Packet descriptors in nonce order; the index is the "kind". */
export const PACKET_DESCRIPTORS: readonly Bytes[] = [
  Uint8Array.of(0x00, 0x00, 0x00), // kind0, outbound patchControl writes
  Uint8Array.of(0x00, 0x00, 0x0f), // handshake
  Uint8Array.of(0x00, 0x00, 0xf0), // kind2, patchStatus
  Uint8Array.of(0x00, 0x0f, 0x00), // kind3, glucoseData
  Uint8Array.of(0x00, 0xf0, 0x00), // kind4, historicData
  Uint8Array.of(0x0f, 0x00, 0x00), // kind5
  Uint8Array.of(0xf0, 0x00, 0x00), // kind6
  Uint8Array.of(0x44, 0x00, 0x00), // patchData
];

export const KIND_PATCH_CONTROL_WRITE = 0;

const PREFERRED_KIND: Partial<Record<Libre3DataChannel, number>> = { patchStatus: 2, glucoseData: 3, historicData: 4 };

/** Data-plane characteristic UUID to channel name. */
export function channelForUuid(uuid: string): Libre3DataChannel | null {
  const lower = uuid.toLowerCase();
  for (const channel of ['patchControl', 'patchStatus', 'glucoseData', 'historicData', 'eventLog', 'clinicalData', 'factoryData'] as const) {
    if (LIBRE3_CHAR[channel] === lower) return channel;
  }
  return null;
}

export class DataPlaneCrypto {
  constructor(private readonly kEnc: Bytes, private readonly ivEnc: Bytes) {
    if (kEnc.length !== 16) throw new Error('kEnc must be 16 bytes');
    if (ivEnc.length !== 8) throw new Error('ivEnc must be 8 bytes');
  }

  nonce(sequence: number, kind: number): Bytes {
    return concatBytes(Uint8Array.of(sequence & 0xff, (sequence >> 8) & 0xff), PACKET_DESCRIPTORS[kind]!, this.ivEnc);
  }

  decrypt(frame: DataFrame, kind: number): Bytes {
    const { encrypted } = frame;
    if (encrypted.length < CCM_TAG_SIZE) throw new Error('Data frame payload shorter than the CCM tag');
    const split = encrypted.length - CCM_TAG_SIZE;
    return ccmDecrypt(this.kEnc, this.nonce(frame.sequenceNumber, kind), encrypted.subarray(0, split), encrypted.subarray(split));
  }

  /** Tries every known descriptor and accepts the first whose tag verifies. */
  decryptTryingAllKinds(frame: DataFrame): { kind: number; plaintext: Bytes } {
    for (let kind = 0; kind < PACKET_DESCRIPTORS.length; kind++) {
      try {
        return { kind, plaintext: this.decrypt(frame, kind) };
      } catch (e) {
        if (!(e instanceof CcmAuthError)) throw e;
      }
    }
    throw new CcmAuthError();
  }

  /** Raw bytes for a notification or write: `ciphertext || tag || seq_LE2`. */
  encrypt(plaintext: Bytes, sequence: number, kind: number): Bytes {
    const { ciphertext, tag } = ccmEncrypt(this.kEnc, this.nonce(sequence, kind), plaintext, CCM_TAG_SIZE);
    return encodeDataFrame(concatBytes(ciphertext, tag), sequence);
  }
}

export type DecodedPayload =
  | { readonly kind: 'realtime'; readonly reading: RealtimeGlucose }
  | { readonly kind: 'patchStatus'; readonly status: PatchStatus }
  | { readonly kind: 'historicalPage'; readonly page: HistoricalPage }
  | { readonly kind: 'clinical'; readonly record: ClinicalRecord }
  | { readonly kind: 'raw'; readonly plaintext: Bytes };

export interface DecodedPacket {
  readonly channel: Libre3DataChannel;
  readonly kind: number;
  readonly payload: DecodedPayload;
}

function decodePayload(channel: Libre3DataChannel, plaintext: Bytes): DecodedPayload {
  try {
    switch (channel) {
      case 'glucoseData': return { kind: 'realtime', reading: decodeRealtime(plaintext) };
      case 'patchStatus': return { kind: 'patchStatus', status: decodePatchStatus(plaintext) };
      case 'historicData': return { kind: 'historicalPage', page: decodeHistoricalPage(plaintext) };
      case 'clinicalData': return { kind: 'clinical', record: decodeClinicalRecord(plaintext) };
      default: break;
    }
  } catch {
    // wrong plaintext size for this channel: surface as raw
  }
  return { kind: 'raw', plaintext };
}

export function decodeDataPlane(crypto: DataPlaneCrypto, channel: Libre3DataChannel, frame: DataFrame): DecodedPacket {
  const preferred = PREFERRED_KIND[channel];
  let result: { kind: number; plaintext: Bytes } | null = null;
  if (preferred !== undefined) {
    try {
      result = { kind: preferred, plaintext: crypto.decrypt(frame, preferred) };
    } catch (e) {
      if (!(e instanceof CcmAuthError)) throw e;
    }
  }
  result ??= crypto.decryptTryingAllKinds(frame);
  return { channel, kind: result.kind, payload: decodePayload(channel, result.plaintext) };
}
