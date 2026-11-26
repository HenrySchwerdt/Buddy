/**
 * Port of `Bluetooth/Pair/DashKeyExchange.swift` from OmnipodKit (MIT License, (c) LoopKit
 * Authors): X25519 key agreement and the CMAC based derivation of the long term key (LTK) and
 * the two key confirmation values. Pure functions, so the exchange can be tested with fixed
 * private keys and nonces.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { bytesEqual, randomBytes } from '../common/bytes';
import { aesCmac, x25519PublicKey, x25519SharedSecret } from './crypto';
import { OmnipodError } from './errors';

export const CMAC_SIZE = 16;
export const PUBLIC_KEY_SIZE = 32;
export const NONCE_SIZE = 16;

const utf8 = (s: string): Bytes => new TextEncoder().encode(s);
const INTERMEDIARY_KEY_MAGIC = utf8('TWIt');
const PDM_CONF_MAGIC_PREFIX = utf8('KC_2_U');
const POD_CONF_MAGIC_PREFIX = utf8('KC_2_V');
const last4 = (b: Bytes): Bytes => b.slice(b.length - 4);

export interface DerivedKeys {
  readonly ltk: Bytes;
  readonly pdmConf: Bytes;
  readonly podConf: Bytes;
}

export function deriveDashKeys(pdmPrivate: Bytes, pdmNonce: Bytes, podPublic: Bytes, podNonce: Bytes): DerivedKeys {
  return deriveDashKeysFromSecret(x25519SharedSecret(pdmPrivate, podPublic), x25519PublicKey(pdmPrivate), pdmNonce, podPublic, podNonce);
}

/** The derivation is symmetric: the pod (simulator) feeds it with the shared secret of its own side. */
export function deriveDashKeysFromSecret(curveLtk: Bytes, pdmPublic: Bytes, pdmNonce: Bytes, podPublic: Bytes, podNonce: Bytes): DerivedKeys {
  const firstKey = concatBytes(last4(podPublic), last4(pdmPublic), last4(podNonce), last4(pdmNonce));
  const intermediateKey = aesCmac(firstKey, curveLtk);
  const tail = concatBytes(INTERMEDIARY_KEY_MAGIC, podNonce, pdmNonce, new Uint8Array([0x00, 0x01]));
  const ltk = aesCmac(intermediateKey, concatBytes(new Uint8Array([0x02]), tail));
  const confKey = aesCmac(intermediateKey, concatBytes(new Uint8Array([0x01]), tail));
  return {
    ltk,
    pdmConf: aesCmac(confKey, concatBytes(PDM_CONF_MAGIC_PREFIX, pdmNonce, podNonce)),
    podConf: aesCmac(confKey, concatBytes(POD_CONF_MAGIC_PREFIX, podNonce, pdmNonce)),
  };
}

/** The controller side of the exchange: holds its ephemeral key pair and nonce. */
export class DashKeyExchange {
  readonly pdmNonce: Bytes;
  readonly pdmPublic: Bytes;
  private readonly pdmPrivate: Bytes;
  private derived: DerivedKeys | null = null;

  constructor(opts: { readonly privateKey?: Bytes; readonly nonce?: Bytes } = {}) {
    this.pdmNonce = opts.nonce ?? randomBytes(NONCE_SIZE);
    this.pdmPrivate = opts.privateKey ?? randomBytes(32);
    this.pdmPublic = x25519PublicKey(this.pdmPrivate);
  }

  /** `payload` is the pod's public key followed by its nonce (the SPS1 answer). */
  updatePodPublicData(payload: Bytes): void {
    if (payload.length !== PUBLIC_KEY_SIZE + NONCE_SIZE) throw new OmnipodError('pairing', 'Invalid payload size');
    this.derived = deriveDashKeys(this.pdmPrivate, this.pdmNonce, payload.slice(0, PUBLIC_KEY_SIZE), payload.slice(PUBLIC_KEY_SIZE));
  }

  private get keys(): DerivedKeys {
    if (!this.derived) throw new OmnipodError('pairing', 'Pod public key not received yet');
    return this.derived;
  }

  get pdmConf(): Bytes {
    return this.keys.pdmConf;
  }

  get ltk(): Bytes {
    return this.keys.ltk;
  }

  validatePodConf(payload: Bytes): void {
    if (!bytesEqual(this.keys.podConf, payload)) throw new OmnipodError('pairing', 'Invalid podConf value received');
  }
}
