/**
 * App credentials for the Libre 3 authorization handshake: a P-256 private key and the matching
 * 162-byte app certificate. Neither RoundWhiteDiscKit nor this port ships any; the host supplies
 * them (same JSON format as RoundWhiteDiscKit `Pairing/AppIdentity.swift`, MIT, (c) the
 * RoundWhiteDiscKit authors) and they live in the keychain-backed `SecretStore`. Never logged.
 *
 * `{ "format": 1, "curve": "P-256", "identities": [ { "label", "privateKeyHex", "certificateHex" } ] }`
 */
import { fromHex, type Bytes, type SecretStore } from '@buddy/core';
import { p256 } from '@noble/curves/nist.js';
import { PHONE_CERT_PUBKEY_OFFSET, PHONE_CERT_SIZE } from './constants';
import { LIBRE3_SECRET_KEYS } from './storage';

export interface AppIdentity {
  readonly label: string;
  readonly privateKey: Bytes;
  /** 162-byte phone certificate, written to the sensor during the full handshake. */
  readonly certificate: Bytes;
}

export class AppIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppIdentityError';
  }
}

const isHexString = (v: unknown, bytes: number): v is string => typeof v === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(v.trim());

/** Public point of the certificate (uncompressed, 65 bytes). */
export const certificatePublicKey = (certificate: Bytes): Bytes => certificate.slice(PHONE_CERT_PUBKEY_OFFSET, PHONE_CERT_PUBKEY_OFFSET + 65);

export function createAppIdentity(label: string, privateKey: Bytes, certificate: Bytes): AppIdentity {
  if (certificate.length !== PHONE_CERT_SIZE) throw new AppIdentityError(`${label}: certificate must be ${PHONE_CERT_SIZE} bytes`);
  const publicKey = certificatePublicKey(certificate);
  if (publicKey[0] !== 0x04) throw new AppIdentityError(`${label}: certificate has no uncompressed P-256 point`);
  if (!p256.utils.isValidSecretKey(privateKey)) throw new AppIdentityError(`${label}: invalid P-256 private key`);
  const derived = p256.getPublicKey(privateKey, false);
  if (derived.length !== publicKey.length || derived.some((b, i) => b !== publicKey[i])) throw new AppIdentityError(`${label}: private key does not match the certificate`);
  return { label, privateKey, certificate };
}

export function parseAppIdentities(json: string): AppIdentity[] {
  let file: unknown;
  try {
    file = JSON.parse(json);
  } catch {
    throw new AppIdentityError('App credential is not valid JSON');
  }
  const f = file as { format?: unknown; curve?: unknown; identities?: unknown };
  if (f.format !== 1 || f.curve !== 'P-256' || !Array.isArray(f.identities)) throw new AppIdentityError('Unsupported app credential format (expected format 1, P-256)');
  return f.identities.map((entry: { label?: unknown; privateKeyHex?: unknown; certificateHex?: unknown }, i) => {
    const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : `identity-${i + 1}`;
    if (!isHexString(entry.privateKeyHex, 32) || !isHexString(entry.certificateHex, PHONE_CERT_SIZE)) throw new AppIdentityError(`${label}: bad hex in app credential`);
    return createAppIdentity(label, fromHex(entry.privateKeyHex.trim()), fromHex(entry.certificateHex.trim()));
  });
}

/** Validates and stores the credential JSON in the secret store. */
export async function installAppIdentities(secrets: SecretStore, json: string): Promise<number> {
  const identities = parseAppIdentities(json);
  if (identities.length === 0) throw new AppIdentityError('App credential contains no identities');
  await secrets.set(LIBRE3_SECRET_KEYS.appIdentities, json);
  return identities.length;
}

/** Installed credentials; empty when none were supplied. */
export async function loadAppIdentities(secrets: SecretStore): Promise<AppIdentity[]> {
  const raw = await secrets.get(LIBRE3_SECRET_KEYS.appIdentities);
  return raw ? parseAppIdentities(raw) : [];
}
