/**
 * Bridge discovery and pairing (port of InsightKit `BridgeSession.beginPairing` and the scan part
 * of `BLEBridgeLink`, PROTOCOL.md section 4.1). The user must be present on both phones: the
 * bridge only accepts pairing for two minutes after "Pair with iPhone" was tapped, and both
 * phones show the same 6-digit code that the user confirms on each.
 *
 * The result carries the pairing key as `pairingSecret`: store it as a secret setting. It is also
 * written to the `SecretStore` when one is passed. It is never logged.
 */
import type { BleAdvertisement, BleTransport, Bytes, Clock, Logger, SecretStore } from '@buddy/core';
import { secureRandom, type RandomSource } from './bytes';
import { openBleChannel, type BridgeChannel } from './ble-channel';
import { ADVERTISED_NAME_PREFIX, BRIDGE_SERVICE_UUID, DEFAULT_TIMEOUTS, type InsightTimeouts } from './constants';
import { encodeCredentials, saveCredentials, type InsightCredentials } from './credentials';
import { commitment, confirmationCode, confirmMacBridge, confirmMacPhone, ecdhSharedSecret, generatePairingKeyPair, longTermKey, verifyMac } from './crypto';
import { encodeHandshake, handshakeBytes, pairConfirmMessage, pairRejectMessage, pairRevealMessage, pairStartMessage } from './handshake';
import { BridgeError } from './models';
import { HandshakeError, HandshakeInbox } from './session';

export interface DiscoveredBridge {
  /** BLE peripheral id (it rotates; only a starting point). */
  readonly id: string;
  /** Display name: the advertised name, else "InsightBridge-" + the last 4 characters of the id. */
  readonly name: string;
  readonly rssi: number | null;
  readonly lastSeen: number;
}

export interface ScanOptions {
  readonly timeoutMs?: number;
  readonly onUpdate?: (devices: readonly DiscoveredBridge[]) => void;
  readonly clock?: Clock;
}

export const bridgeDisplayName = (ad: Pick<BleAdvertisement, 'id' | 'name'>): string => {
  if (ad.name && ad.name.length > 0) return ad.name;
  return `${ADVERTISED_NAME_PREFIX}${ad.id.replace(/[^0-9a-zA-Z]/g, '').slice(-4).toUpperCase() || '????'}`;
};

/**
 * Scans for bridges (identified by the service UUID, never by name: the bridge does not rename the phone's
 * adapter). Resolves when the timeout elapses or `ble.stopScan()` is called.
 */
export async function scanInsightBridges(ble: BleTransport, options: ScanOptions = {}): Promise<DiscoveredBridge[]> {
  const found = new Map<string, DiscoveredBridge>();
  const now = options.clock ? () => options.clock!.now() : () => Date.now();
  const state = await ble.state();
  if (state !== 'poweredOn') throw new BridgeError('bluetoothUnavailable', null, state === 'poweredOff' ? 'Bluetooth is turned off.' : 'Bluetooth is not available.');
  await ble.scan({ services: [BRIDGE_SERVICE_UUID], timeoutMs: options.timeoutMs ?? 30_000 }, (ad) => {
    found.set(ad.id, { id: ad.id, name: bridgeDisplayName(ad), rssi: ad.rssi, lastSeen: now() });
    options.onUpdate?.([...found.values()]);
  });
  return [...found.values()];
}

export type PairingEvent =
  /** `pairStart` sent; waiting for the bridge to answer. */
  | { readonly kind: 'waitingForBridge' }
  /** Show this code on both phones; call `confirmCode(matches)`. */
  | { readonly kind: 'confirmCode'; readonly code: string }
  /** The user confirmed here; waiting for the Android confirmation. */
  | { readonly kind: 'waitingForBridgeConfirmation' }
  | { readonly kind: 'completed'; readonly result: PairingResult }
  | { readonly kind: 'failed'; readonly error: BridgeError };

export interface PairingResult {
  readonly bridgeId: string;
  readonly bridgeName: string;
  /** The peripheral the pairing ran on (the starting point for reconnects). */
  readonly peripheralId: string;
  /** Pairing key material as JSON: store as the secret setting `pairingSecret`. Never log it. */
  readonly pairingSecret: string;
}

export interface PairingOptions {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly peripheralId: string;
  /** Shown in the result / settings. */
  readonly name?: string;
  /** Also stores the credentials here (keyed by bridge id). */
  readonly secrets?: SecretStore;
  readonly timeouts?: Partial<InsightTimeouts>;
  readonly random?: RandomSource;
  readonly onEvent?: (e: PairingEvent) => void;
}

export interface InsightPairing {
  /** The user answers "codes match" (true) or "cancel" (false). Ignored before a code was shown. */
  confirmCode(matches: boolean): void;
  cancel(): void;
  /** Resolves with the result; rejects with a `BridgeError`. */
  readonly done: Promise<PairingResult>;
}

const pairingFailure = (reason: string): BridgeError => new BridgeError('pairingRejected', null, reason);

export function pairInsightBridge(options: PairingOptions): InsightPairing {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const random = options.random ?? secureRandom;
  let decide: ((matches: boolean) => void) | null = null;
  let cancelled = false;
  let channel: BridgeChannel | null = null;
  let codeShown = false;
  const emit = (e: PairingEvent) => options.onEvent?.(e);

  const run = async (): Promise<PairingResult> => {
    const state = await options.ble.state();
    if (state !== 'poweredOn') throw new BridgeError('bluetoothUnavailable', null, state === 'poweredOff' ? 'Bluetooth is turned off.' : 'Bluetooth is not available.');
    let conn;
    try {
      conn = await options.ble.connect(options.peripheralId, { timeoutMs: 15_000 });
    } catch {
      throw new BridgeError('notConnected', null, 'The bridge could not be reached.');
    }
    const ch = await openBleChannel(conn, options.clock, options.log);
    channel = ch;
    const inbox = new HandshakeInbox(ch);
    const send = async (m: Parameters<typeof encodeHandshake>[0]) => {
      try {
        await ch.send(encodeHandshake(m));
      } catch {
        throw new BridgeError('linkLost');
      }
    };
    const receive = async (ms: number) => {
      try {
        return await inbox.next(ms);
      } catch (e) {
        if (cancelled) throw pairingFailure('userRejected');
        throw e instanceof HandshakeError && e.reason === 'silent' ? new BridgeError('timeout') : new BridgeError('linkLost');
      }
    };

    // v2: only a commitment goes out first; the values are revealed after the bridge answered.
    const keys = generatePairingKeyPair(random);
    const nonceI = random(16);
    const clientId = hexOf(random(8));
    await send(pairStartMessage(commitment(keys.publicKey, nonceI)));
    emit({ kind: 'waitingForBridge' });

    const resp = await receive(timeouts.pairingResponseMs);
    if (resp.t === 'pairReject') throw pairingFailure(typeof resp.reason === 'string' ? resp.reason : 'rejected');
    const pub = handshakeBytes(resp, 'pub');
    const nonceB = handshakeBytes(resp, 'nonce', 16);
    const bridgeId = typeof resp.bridgeId === 'string' ? resp.bridgeId : '';
    if (resp.t !== 'pairResp' || !pub || !nonceB || bridgeId.length === 0) throw new BridgeError('protocolViolation', null, 'pairResp');

    let ltk: Bytes;
    try {
      ltk = longTermKey(ecdhSharedSecret(keys.privateKey, pub), nonceI, nonceB);
    } catch {
      throw new BridgeError('protocolViolation', null, 'pairResp key');
    }
    await send(pairRevealMessage(keys.publicKey, nonceI));

    // Wait for the user's verdict while watching the bridge (it may abort).
    const bridgeSays = receive(timeouts.pairingConfirmMs);
    bridgeSays.catch(() => undefined);
    const userSays = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    codeShown = true;
    emit({ kind: 'confirmCode', code: confirmationCode(ltk) });
    const first = await Promise.race([userSays.then((matches) => ({ user: matches })), bridgeSays.then((message) => ({ message }))]);
    if ('message' in first) {
      // Whatever the bridge sends before the user confirmed here is never accepted (pairDone included).
      throw first.message.t === 'pairReject' ? pairingFailure(typeof first.message.reason === 'string' ? first.message.reason : 'rejected') : new BridgeError('protocolViolation', null, 'pairDone');
    }
    if (!first.user) {
      await send(pairRejectMessage('userRejected')).catch(() => undefined);
      throw pairingFailure('userRejected');
    }
    await send(pairConfirmMessage(confirmMacPhone(ltk)));
    emit({ kind: 'waitingForBridgeConfirmation' });

    const done = await bridgeSays;
    if (done.t === 'pairReject') throw pairingFailure(typeof done.reason === 'string' ? done.reason : 'rejected');
    const mac = handshakeBytes(done, 'mac');
    if (done.t !== 'pairDone' || !mac) throw new BridgeError('protocolViolation', null, 'pairDone');
    if (!verifyMac(mac, confirmMacBridge(ltk))) throw new BridgeError('macMismatch');

    const creds: InsightCredentials = { bridgeId, ltk, clientId };
    if (options.secrets) {
      try {
        await saveCredentials(options.secrets, creds);
      } catch {
        throw new BridgeError('protocolViolation', null, 'could not store key');
      }
    }
    return { bridgeId, bridgeName: options.name ?? `${ADVERTISED_NAME_PREFIX}${bridgeId.slice(-4).toUpperCase()}`, peripheralId: options.peripheralId, pairingSecret: encodeCredentials(creds) };
  };

  const done = run().then(
    async (result) => {
      await channel?.close().catch(() => undefined);
      emit({ kind: 'completed', result });
      return result;
    },
    async (e: unknown) => {
      await channel?.close().catch(() => undefined);
      const error = e instanceof BridgeError ? e : new BridgeError('linkLost');
      options.log.warn(`Insight: pairing failed (${error.kind})`);
      emit({ kind: 'failed', error });
      throw error;
    },
  );
  done.catch(() => undefined);

  return {
    done,
    confirmCode: (matches) => {
      if (codeShown && decide) {
        const d = decide;
        decide = null;
        d(matches);
      }
    },
    cancel: () => {
      cancelled = true;
      if (decide) {
        const d = decide;
        decide = null;
        d(false);
      } else {
        // Before the code was shown: tell the bridge (best effort) and drop the link.
        const ch = channel as BridgeChannel | null;
        void ch?.send(encodeHandshake(pairRejectMessage('userRejected'))).catch(() => undefined).finally(() => void ch?.close());
      }
    },
  };
}

const hexOf = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
