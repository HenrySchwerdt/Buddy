/**
 * Pairing credentials of a bridge: the long-term key (LTK) and this phone's client id
 * (InsightKit keeps them in the Keychain, keyed by bridge id). They live in Buddy's `SecretStore`;
 * the same JSON can also come from the secret setting `pairingSecret`. Never logged.
 */
import { fromHex, hex, type Bytes, type SecretStore } from '@buddy/core';
import { hexDecode } from './bytes';

export interface InsightCredentials {
  readonly bridgeId: string;
  /** 32-byte long-term key */
  readonly ltk: Bytes;
  /** 8 random bytes, hex */
  readonly clientId: string;
}

export const credentialsKey = (bridgeId: string): string => `insight:credentials:${bridgeId.toLowerCase()}`;

/** Serialises credentials for storage (the string is a secret). */
export const encodeCredentials = (c: InsightCredentials): string => JSON.stringify({ v: 1, bridgeId: c.bridgeId, ltk: hex(c.ltk), clientId: c.clientId });

/** Validates everything read back from storage; `null` for anything unusable. */
export function decodeCredentials(text: string | null | undefined): InsightCredentials | null {
  if (!text) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.bridgeId !== 'string' || o.bridgeId.length === 0 || typeof o.clientId !== 'string' || o.clientId.length === 0) return null;
  if (typeof o.ltk !== 'string') return null;
  const ltk = hexDecode(o.ltk);
  if (!ltk || ltk.length !== 32) return null;
  return { bridgeId: o.bridgeId, ltk: fromHex(o.ltk), clientId: o.clientId };
}

export async function saveCredentials(secrets: SecretStore, c: InsightCredentials): Promise<void> {
  await secrets.set(credentialsKey(c.bridgeId), encodeCredentials(c));
}

export async function loadCredentials(secrets: SecretStore, bridgeId: string): Promise<InsightCredentials | null> {
  const c = decodeCredentials(await secrets.get(credentialsKey(bridgeId)));
  return c && c.bridgeId.toLowerCase() === bridgeId.toLowerCase() ? c : null;
}

export async function deleteCredentials(secrets: SecretStore, bridgeId: string): Promise<void> {
  await secrets.set(credentialsKey(bridgeId), null);
}
