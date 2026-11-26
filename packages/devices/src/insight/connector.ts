/**
 * Finds and authenticates the paired bridge (port of the supervisor logic of InsightKit
 * `BLEBridgeLink` and the verdict rules of `BridgeSession`, PROTOCOL.md section 1a).
 *
 * Android rotates the bridge's BLE address, so the remembered peripheral id is only a starting
 * point: if it does not authenticate the connector scans for the service UUID and tries every
 * candidate that is not on the ignore list. The first candidate that completes the session
 * handshake as the paired bridge wins; a candidate that rejects the session, names another bridge
 * or fails the MAC is ignored for 10 minutes. Only the remembered bridge itself can make the
 * pairing look broken, and only when it rejects twice (a single unauthenticated `sessionReject`
 * could come from anybody in radio range).
 */
import type { BleAdvertisement, BleTransport, Clock, Logger } from '@buddy/core';
import type { RandomSource } from './bytes';
import { openBleChannel, type BridgeChannel } from './ble-channel';
import { BRIDGE_SERVICE_UUID, type InsightTimeouts } from './constants';
import type { InsightCredentials } from './credentials';
import { BridgeError } from './models';
import { HandshakeError, InsightSession } from './session';

/** A device that never completed the handshake (silent) is skipped for this long. */
const SILENT_IGNORE_MS = 2 * 60_000;
/** A rejected session is only believed after it happened twice, this far apart. */
const SESSION_REJECT_RETRY_MS = 30_000;

export interface ConnectorOptions {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly timeouts: InsightTimeouts;
  readonly random: RandomSource;
  readonly appName: string;
}

export interface ConnectedBridge {
  readonly session: InsightSession;
  readonly peripheralId: string;
}

export class BridgeConnector {
  private readonly ignored = new Map<string, number>();
  private repairSuspected = false;
  private needsRepair = false;

  constructor(private readonly opts: ConnectorOptions) {}

  /** The bridge rejected this phone twice: pair again. No scanning happens until `reset()`. */
  get requiresRepair(): boolean {
    return this.needsRepair;
  }

  reset(): void {
    this.ignored.clear();
    this.repairSuspected = false;
    this.needsRepair = false;
  }

  private isIgnored(id: string): boolean {
    const until = this.ignored.get(id);
    if (until === undefined) return false;
    if (until <= this.opts.clock.now()) {
      this.ignored.delete(id);
      return false;
    }
    return true;
  }

  private ignore(id: string, ms: number): void {
    this.ignored.set(id, this.opts.clock.now() + ms);
  }

  /** Brings up an authenticated session within `timeouts.connectMs`, or throws a certain `BridgeError`. */
  async connect(creds: InsightCredentials, target: string | null): Promise<ConnectedBridge> {
    if (this.needsRepair) throw new BridgeError('sessionRejected');
    const { ble, timeouts } = this.opts;
    const state = await ble.state();
    if (state !== 'poweredOn') throw new BridgeError('bluetoothUnavailable', null, bluetoothReason(state));

    const deadline = Date.now() + timeouts.connectMs;
    const tried = new Set<string>();
    let lastFailure: unknown = null;

    const attempt = async (id: string): Promise<ConnectedBridge | null> => {
      tried.add(id);
      try {
        return await this.tryCandidate(id, creds, id === target);
      } catch (e) {
        lastFailure = e;
        if (e instanceof BridgeError) throw e; // needs re-pair / incompatible: stop searching
        return null;
      }
    };

    if (target && !this.isIgnored(target)) {
      const hit = await attempt(target);
      if (hit) return hit;
    }
    while (Date.now() < deadline) {
      const found: string[] = [];
      await ble.scan({ services: [BRIDGE_SERVICE_UUID], timeoutMs: Math.max(1, Math.min(timeouts.scanMs, deadline - Date.now())) }, (ad: BleAdvertisement) => {
        if (!found.includes(ad.id)) {
          found.push(ad.id);
          ble.stopScan(); // connect right away: the address rotates, the advertisement may vanish
        }
      });
      for (const id of found) {
        if (this.isIgnored(id) || (tried.has(id) && id === target)) continue;
        const hit = await attempt(id);
        if (hit) return hit;
        if (Date.now() >= deadline) break;
      }
      // Nothing found, or every candidate failed: do not spin, but never back off beyond a short pause.
      await sleep(Math.min(found.length > 0 ? 500 : 50, Math.max(0, deadline - Date.now())));
    }
    const why = lastFailure instanceof HandshakeError ? lastFailure.reason : 'no bridge found';
    this.opts.log.warn(`Insight: could not reach the bridge (${why})`);
    throw new BridgeError('notConnected', null, why);
  }

  private async tryCandidate(id: string, creds: InsightCredentials, isTarget: boolean): Promise<ConnectedBridge | null> {
    const { ble, clock, log, timeouts } = this.opts;
    let channel: BridgeChannel | null = null;
    try {
      const conn = await ble.connect(id, { timeoutMs: Math.min(10_000, timeouts.connectMs) });
      channel = await openBleChannel(conn, clock, log);
      const session = await InsightSession.open(channel, creds, { clock, log, timeouts, random: this.opts.random, appName: this.opts.appName });
      this.repairSuspected = false;
      return { session, peripheralId: id };
    } catch (e) {
      await channel?.close().catch(() => undefined);
      if (!(e instanceof HandshakeError)) {
        log.info('Insight: candidate connection failed');
        return null;
      }
      return this.judge(id, e, isTarget);
    }
  }

  /** The verdict on a candidate that answered but did not authenticate. */
  private judge(id: string, e: HandshakeError, isTarget: boolean): null {
    switch (e.reason) {
      case 'incompatible':
        throw new BridgeError('unsupportedProtocol');
      case 'busy':
        throw BridgeError.remote('busy');
      case 'silent':
      case 'link':
      case 'protocol':
        if (!isTarget) this.ignore(id, SILENT_IGNORE_MS);
        return null;
      case 'otherBridge':
        this.ignore(id, this.opts.timeouts.ignoreMs);
        return null;
      case 'rejected':
      case 'macMismatch':
        if (!isTarget) {
          this.opts.log.warn('Insight: a candidate other than the remembered bridge failed the handshake: ignored');
          this.ignore(id, this.opts.timeouts.ignoreMs);
          return null;
        }
        if (this.repairSuspected) {
          this.needsRepair = true;
          throw new BridgeError(e.reason === 'macMismatch' ? 'macMismatch' : 'sessionRejected');
        }
        // Only believed when it repeats on a later connection.
        this.repairSuspected = true;
        this.ignore(id, SESSION_REJECT_RETRY_MS);
        return null;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bluetoothReason(state: string): string {
  switch (state) {
    case 'poweredOff':
      return 'Bluetooth is turned off.';
    case 'unauthorized':
      return 'Buddy is not allowed to use Bluetooth.';
    case 'unsupported':
      return 'This device does not support Bluetooth LE.';
    default:
      return 'Bluetooth is not ready yet.';
  }
}
