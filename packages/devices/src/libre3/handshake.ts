/**
 * Libre 3 BLE authorization: certificate and ephemeral exchange, kAuth derivation, the Phase 5
 * challenge and the Phase 6 session material, plus the shorter cached reconnect path.
 *
 * TypeScript port of RoundWhiteDiscKit `Pairing/PairingFlow.swift`, `SensorCert.swift`,
 * `EphemeralExchange.swift`, `AppIdentity.swift`, `ChallengeMessage.swift` and `Phase6Response.swift`
 * (MIT, (c) the RoundWhiteDiscKit authors), with the reconnect policy of LibreLoop
 * `LibreLoopPairingService.swift` (MIT, (c) the LibreLoop authors): an already active sensor is
 * only reconnected through the cached path, the full path is for first pair / re-pair.
 *
 * Keys, shared secrets and session material are never logged.
 */
import { concatBytes, type Bytes } from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CcmAuthError, ccmDecrypt, ccmEncrypt } from './ccm';
import {
  CCM_TAG_SIZE, CHALLENGE_NOTIFY_SIZE, EPHEMERAL_WRITE_SIZE, PATCH_SIGNING_KEYS, PHASE5_WIRE_SIZE, PHASE6_WIRE_SIZE, SEC_CMD, SEC_RESPONSE, SENSOR_CERT_SIZE,
} from './constants';
import type { AppIdentity } from './identity';
import { MailboxTimeoutError } from './mailbox';
import { WriteTimeoutError, type SecurityLink } from './link';

/** transport: retry; credential: may mean re-pair (use a generous threshold); protocol: unexpected bytes. */
export type HandshakeErrorKind = 'transport' | 'credential' | 'protocol';

export class Libre3HandshakeError extends Error {
  constructor(readonly kind: HandshakeErrorKind, message: string, readonly stage?: string) {
    super(message);
    this.name = 'Libre3HandshakeError';
  }
}

/** Phase 6 session material for the encrypted data plane. */
export interface SessionMaterial {
  readonly kEnc: Bytes;
  readonly ivEnc: Bytes;
}

export interface HandshakeOptions {
  readonly link: SecurityLink;
  readonly random: (length: number) => Bytes;
  /** 4-byte BLE PIN from the NFC activation / switch response (Phase 5 tail). */
  readonly blePin: Bytes;
  readonly signingKeys?: readonly Bytes[];
}

const equal = (a: Bytes, b: Bytes): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function classify(error: unknown, stage: string): Libre3HandshakeError {
  if (error instanceof Libre3HandshakeError) return error;
  if (error instanceof MailboxTimeoutError || error instanceof WriteTimeoutError) return new Libre3HandshakeError('transport', `${(error as Error).message} (${stage})`, stage);
  if (error instanceof CcmAuthError) return new Libre3HandshakeError('credential', `Phase 6 could not be verified (${stage})`, stage);
  return new Libre3HandshakeError('transport', `${(error as Error).message} (${stage})`, stage);
}

async function step<T>(stage: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw classify(e, stage);
  }
}

async function expectResponse(link: SecurityLink, prefix: number, stage: string): Promise<void> {
  const actual = await step(stage, () => link.awaitCommand());
  if (actual[0] !== prefix) throw new Libre3HandshakeError('protocol', `Unexpected command response in ${stage}`, stage);
}

const xCoordinate = (privateKey: Bytes, peerPublic: Bytes): Bytes => p256.getSharedSecret(privateKey, peerPublic, true).slice(1);

/** `kAuth = SHA-256(00 00 00 01 || Ze || Zs)[0..16]`; Ze is ephemeral x ephemeral, Zs is static x static. */
export function deriveAuthKey(phoneEphemeralPrivate: Bytes, sensorEphemeralPublic: Bytes, appStaticPrivate: Bytes, sensorStaticPublic: Bytes): Bytes {
  const ze = xCoordinate(phoneEphemeralPrivate, sensorEphemeralPublic);
  const zs = xCoordinate(appStaticPrivate, sensorStaticPublic);
  return sha256(concatBytes(Uint8Array.of(0, 0, 0, 1), ze, zs)).slice(0, 16);
}

/** ECDSA-P256(SHA-256) over `cert[0..76]`, raw r||s at `cert[76..140]`; returns the index of the key that verified. */
export function verifySensorCertificate(cert: Bytes, signingKeys: readonly Bytes[] = PATCH_SIGNING_KEYS): number | null {
  if (cert.length !== SENSOR_CERT_SIZE || cert[11] !== 0x04) throw new Libre3HandshakeError('protocol', 'Malformed sensor certificate', 'sensorCertificate');
  const signed = cert.subarray(0, 76);
  const signature = cert.subarray(76);
  for (let i = 0; i < signingKeys.length; i++) {
    try {
      if (p256.verify(signature, signed, signingKeys[i]!, { lowS: false })) return i;
    } catch {
      // malformed key or signature for this candidate: try the next one
    }
  }
  return null;
}

/** Phase 5 + Phase 6 under `kAuth`, after the sensor's `R1 || nonce7` challenge was received. */
async function completeAuthorization(o: HandshakeOptions, r1: Bytes, nonce7: Bytes, kAuth: Bytes): Promise<SessionMaterial> {
  if (o.blePin.length !== 4) throw new Libre3HandshakeError('protocol', 'BLE PIN must be 4 bytes', 'phase5');
  const r2 = o.random(16);
  const { ciphertext, tag } = ccmEncrypt(kAuth, nonce7, concatBytes(r1, r2, o.blePin), CCM_TAG_SIZE);
  const wire = new Uint8Array(PHASE5_WIRE_SIZE);
  wire.set(concatBytes(ciphertext, tag));
  await step('phase5', () => o.link.write('challengeData', wire, 'phase5'));
  await step('challengeLoadDone', () => o.link.writeCommand(SEC_CMD.challengeLoadDone, 'SendChallengeLoadDone'));
  await expectResponse(o.link, SEC_RESPONSE.challengeLoadDone, 'patchChallengeLoadDone');

  const raw = await step('phase6', () => o.link.awaitNotify('challengeData', PHASE6_WIRE_SIZE));
  let plaintext: Bytes;
  try {
    plaintext = ccmDecrypt(kAuth, raw.subarray(60, 67), raw.subarray(0, 56), raw.subarray(56, 60));
  } catch (e) {
    throw classify(e, 'phase6');
  }
  if (!equal(plaintext.subarray(0, 16), r2)) throw new Libre3HandshakeError('credential', 'Phase 6 R2 echo mismatch', 'phase6');
  if (!equal(plaintext.subarray(16, 32), r1)) throw new Libre3HandshakeError('credential', 'Phase 6 R1 echo mismatch', 'phase6');
  return { kEnc: plaintext.slice(32, 48), ivEnc: plaintext.slice(48, 56) };
}

async function startAuthorization(link: SecurityLink): Promise<{ r1: Bytes; nonce7: Bytes }> {
  await step('startAuthorization', () => link.writeCommand(SEC_CMD.startAuthorization, 'StartAuthorization'));
  await expectResponse(link, SEC_RESPONSE.challengeLoadDone, 'challengeLoadDone');
  const challenge = await step('r1Challenge', () => link.awaitNotify('challengeData', CHALLENGE_NOTIFY_SIZE));
  return { r1: challenge.slice(0, 16), nonce7: challenge.slice(16, 23) };
}

/** Cached/direct reconnect: `0x11`, R1 challenge, Phase 5 under the saved kAuth, Phase 6. */
export async function runCachedReconnect(o: HandshakeOptions, kAuth: Bytes): Promise<SessionMaterial> {
  const { r1, nonce7 } = await startAuthorization(o.link);
  return completeAuthorization(o, r1, nonce7, kAuth);
}

/** Full command-gated authorization with an app credential; also yields the kAuth to cache. */
export async function runFullAuthorization(o: HandshakeOptions, identity: AppIdentity): Promise<{ material: SessionMaterial; kAuth: Bytes }> {
  const { link } = o;
  await step('startAuthentication', () => link.writeCommand(SEC_CMD.startAuthentication, 'StartAuthentication'));
  await step('loadCertificate', () => link.writeCommand(SEC_CMD.loadCertificate, 'LoadCertificate'));
  await step('phoneCertificate', () => link.write('certData', identity.certificate, 'phoneCertWrite'));
  await step('certificateLoadDone', () => link.writeCommand(SEC_CMD.certificateLoadDone, 'SendCertificateLoadDone'));
  await expectResponse(link, SEC_RESPONSE.certificateAccepted, 'certificateAccepted');
  await step('getCertificate', () => link.writeCommand(SEC_CMD.getCertificate, 'GetCertificate'));
  await expectResponse(link, SEC_RESPONSE.certificateReady, 'certificateReady');

  const sensorCert = await step('sensorCertificate', () => link.awaitNotify('certData', SENSOR_CERT_SIZE));
  if (verifySensorCertificate(sensorCert, o.signingKeys) === null) throw new Libre3HandshakeError('credential', 'Sensor certificate signature did not verify', 'sensorCertificate');
  const sensorStatic = sensorCert.slice(11, 76);

  await step('validateCertificate', () => link.writeCommand(SEC_CMD.validateCertificate, 'ValidateCertificate'));
  const ephemeralPrivate = p256.utils.randomSecretKey(o.random(48));
  const ephemeralPublic = p256.getPublicKey(ephemeralPrivate, false);
  const padded = new Uint8Array(EPHEMERAL_WRITE_SIZE);
  padded.set(ephemeralPublic);
  await step('phoneEphemeral', () => link.write('certData', padded, 'phoneEphemeralWrite'));
  await step('ephemeralDone', () => link.writeCommand(SEC_CMD.ephemeralDone, 'SendEphemeralDone'));
  await expectResponse(link, SEC_RESPONSE.ephemeralReady, 'ephemeralReady');
  const sensorEphemeral = await step('sensorEphemeral', () => link.awaitNotify('certData', 65));
  if (sensorEphemeral[0] !== 0x04) throw new Libre3HandshakeError('protocol', 'Sensor ephemeral key is not an uncompressed point', 'sensorEphemeral');

  let kAuth: Bytes;
  try {
    kAuth = deriveAuthKey(ephemeralPrivate, sensorEphemeral, identity.privateKey, sensorStatic);
  } catch {
    throw new Libre3HandshakeError('protocol', 'Sensor key agreement failed', 'ecdh');
  }
  const { r1, nonce7 } = await startAuthorization(link);
  return { material: await completeAuthorization(o, r1, nonce7, kAuth), kAuth };
}

