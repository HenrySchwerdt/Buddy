/**
 * Port of `Bluetooth/Session/SessionEstablisher.swift` (PRIMARY mode, i.e. DASH) from OmnipodKit
 * (MIT License, (c) LoopKit Authors): EAP-AKA with MILENAGE derives the per-connection session
 * key (CK) and the nonce prefix from the long term key. The pod answers a stale sequence number
 * with a resynchronisation (AUTS) which the caller handles by retrying.
 *
 * DELIBERATELY NOT PORTED: the SECONDARY mode (pod-initiated challenge), which only Omnipod 5 uses.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { bytesEqual, randomBytes } from '../common/bytes';
import { OmnipodError } from './errors';
import {
  EapAttr,
  EapCode,
  SUBTYPE_SYNCHRONIZATION_FAILURE,
  autn as eapAutn,
  customIv,
  encodeEap,
  findAttribute,
  parseEap,
  rand as eapRand,
} from './eap';
import type { PodLink } from './link';
import { makePacket, MessageType } from './message-packet';
import { eapSqnBytes, eapSqnToInt, milenage, RESYNC_AMF } from './milenage';

const IV_SIZE = 4;

export type SessionResult =
  | { readonly kind: 'keys'; readonly ck: Bytes; readonly noncePrefix: Bytes; readonly msgSeq: number }
  | { readonly kind: 'resync'; readonly eapSqn: number; readonly msgSeq: number };

export async function negotiateSessionKeys(
  link: PodLink,
  p: { readonly ltk: Bytes; readonly eapSqn: number; readonly myId: number; readonly podId: number; readonly msgSeq: number },
): Promise<SessionResult> {
  if (p.ltk.length !== 16) throw new OmnipodError('session', 'LTK has to be 16 bytes long');
  const sqn = eapSqnBytes(p.eapSqn);
  const controllerIV = randomBytes(IV_SIZE);
  const m = milenage({ k: p.ltk, sqn });
  const identifier = 0;
  let msgSeq = p.msgSeq + 1;

  const challenge = makePacket({
    type: MessageType.SESSION_ESTABLISHMENT,
    source: p.myId,
    destination: p.podId,
    payload: encodeEap({ code: EapCode.REQUEST, identifier, subType: 0, attributes: [eapAutn(m.autn), eapRand(m.rand), customIv(controllerIV)] }),
    sequenceNumber: msgSeq,
  });
  const sent = await link.sendMessagePacket(challenge);
  if (sent.kind !== 'sentWithAcknowledgment') throw new OmnipodError('session', `Could not send the EAP-AKA challenge: ${sent.kind}`);

  const response = parseEap((await link.readMessagePacket()).payload);
  if (response.identifier !== identifier) throw new OmnipodError('session', `Received incorrect EAP identifier ${response.identifier}`);

  const aut = findAttribute(response, EapAttr.AUTS);
  if (response.subType === SUBTYPE_SYNCHRONIZATION_FAILURE && response.attributes.length === 1 && aut) {
    const fromAuts = milenage({ k: p.ltk, sqn, rand: m.rand, auts: aut.payload });
    const resynced = milenage({ k: p.ltk, sqn: fromAuts.synchronizationSqn, rand: m.rand, auts: aut.payload, amf: RESYNC_AMF });
    if (!bytesEqual(resynced.macS, resynced.receivedMacS)) throw new OmnipodError('session', 'MacS mismatch while resynchronising');
    return { kind: 'resync', eapSqn: eapSqnToInt(fromAuts.synchronizationSqn), msgSeq };
  }

  if (response.attributes.length !== 2) {
    if (response.attributes.length === 1 && response.attributes[0]!.type === EapAttr.CLIENT_ERROR_CODE) throw new OmnipodError('session', 'Pod rejected the EAP-AKA challenge (client error code)');
    throw new OmnipodError('session', `Expecting two EAP attributes, got ${response.attributes.length}`);
  }
  const res = findAttribute(response, EapAttr.RES);
  const iv = findAttribute(response, EapAttr.CUSTOM_IV);
  if (!res || !iv) throw new OmnipodError('session', 'EAP-AKA response misses RES or IV');
  if (!bytesEqual(res.payload, m.res)) throw new OmnipodError('session', 'RES mismatch: the pod does not share this long term key');
  const nodeIV = iv.payload.slice(0, IV_SIZE);

  msgSeq += 1;
  const success = makePacket({
    type: MessageType.SESSION_ESTABLISHMENT,
    source: p.myId,
    destination: p.podId,
    payload: encodeEap({ code: EapCode.SUCCESS, identifier, subType: 0, attributes: [] }),
    sequenceNumber: msgSeq,
  });
  await link.sendMessagePacket(success); // OmnipodKit ignores the outcome as well
  return { kind: 'keys', ck: m.ck, noncePrefix: concatBytes(controllerIV, nodeIV), msgSeq };
}
