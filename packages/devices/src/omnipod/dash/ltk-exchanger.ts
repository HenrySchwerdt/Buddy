/**
 * Port of `Bluetooth/Pair/DashLTKExchanger.swift` from OmnipodKit (MIT License, (c) LoopKit
 * Authors): the SP1/SP2, SPS1, SPS2, SP0GP0/P0 pairing dialogue that ends in a shared 16 byte
 * long term key (LTK). The LTK is returned to the caller and never logged.
 */
import { fromHex, type Bytes } from '@buddy/core';
import { be32, bytesEqual } from '../common/bytes';
import { POD_ID_NOT_ACTIVATED } from './constants';
import { OmnipodError } from './errors';
import { DashKeyExchange, CMAC_SIZE } from './key-exchange';
import type { PodLink, SendResult } from './link';
import { makePacket, MessageType, type MessagePacket } from './message-packet';
import { formatKeys, parseKeys } from './string-prefix';

/** Unexplained status request the PDM sends as "SP2" (kept byte for byte). */
export const GET_POD_STATUS_HEX_COMMAND = fromHex('ffc32dbd08030e0100008a');
const SP1 = 'SP1=';
const SP2 = ',SP2=';
const SPS1 = 'SPS1=';
const SPS2 = 'SPS2=';
const SP0GP0 = 'SP0,GP0';
const P0 = 'P0=';
const UNKNOWN_P0_PAYLOAD = new Uint8Array([0xa5]);

export interface PairResult {
  readonly ltk: Bytes;
  readonly address: number;
  readonly msgSeq: number;
}

export function pairMessage(sequenceNumber: number, source: number, destination: number, keys: readonly string[], payloads: readonly Bytes[]): MessagePacket {
  return makePacket({ type: MessageType.PAIRING, source, destination, payload: formatKeys(keys, payloads), sequenceNumber, sas: true });
}

async function sendOrThrow(link: PodLink, msg: MessagePacket, what: string): Promise<void> {
  const r: SendResult = await link.sendMessagePacket(msg);
  if (r.kind !== 'sentWithAcknowledgment') throw new OmnipodError('pairing', `Could not send ${what}: ${r.kind}`);
}

export async function negotiateLtk(
  link: PodLink,
  ids: { readonly myId: number; readonly podId: number },
  keyExchange: DashKeyExchange = new DashKeyExchange(),
): Promise<PairResult> {
  const podAddress = POD_ID_NOT_ACTIVATED;
  let seq = 1;

  await sendOrThrow(link, pairMessage(seq, ids.myId, podAddress, [SP1, SP2], [be32(ids.podId), GET_POD_STATUS_HEX_COMMAND]), 'SP1/SP2');
  seq += 1;
  await sendOrThrow(link, pairMessage(seq, ids.myId, podAddress, [SPS1], [new Uint8Array([...keyExchange.pdmPublic, ...keyExchange.pdmNonce])]), 'SPS1');

  const podSps1 = await link.readMessagePacket();
  keyExchange.updatePodPublicData(parseKeys([SPS1], podSps1.payload)[0]!);

  seq += 1;
  await sendOrThrow(link, pairMessage(seq, ids.myId, podAddress, [SPS2], [keyExchange.pdmConf]), 'SPS2');
  const podSps2 = await link.readMessagePacket();
  const podConf = parseKeys([SPS2], podSps2.payload)[0]!;
  if (podConf.length !== CMAC_SIZE) throw new OmnipodError('pairing', 'Invalid SPS2 payload size');
  keyExchange.validatePodConf(podConf);

  seq += 1;
  await sendOrThrow(link, pairMessage(seq, ids.myId, podAddress, [SP0GP0], [new Uint8Array(0)]), 'SP0GP0');
  const p0 = await link.readMessagePacket();
  if (!bytesEqual(parseKeys([P0], p0.payload)[0]!, UNKNOWN_P0_PAYLOAD)) throw new OmnipodError('pairing', 'Received invalid P0 payload');

  const ltk = keyExchange.ltk;
  if (ltk.length !== 16) throw new OmnipodError('pairing', 'Invalid long term key');
  return { ltk, address: ids.podId, msgSeq: seq };
}
