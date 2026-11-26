/**
 * TypeScript port of SyaiBLE.swift (connect/auth/firmware gate), SyaiSensorSession.swift and the
 * discovery half of SyaiBLECentral.swift from SyaiKit (MIT, © 2026 Nightscout Foundation).
 *
 * One `SyaiSession` is one authenticated BLE link: scan for the sensor's MAC (advertised in the
 * manufacturer data), connect, run the P-256 handshake, refuse firmware whose readings cannot be
 * decoded (before anything else is written), write the fast BLE-interval profile, read the cmd
 * lifecycle state, then subscribe to the live, history and status characteristics and decrypt
 * their frames. The session key is held in memory only and never logged.
 */
import type { BleConnection, BleTransport, Bytes, Clock, Logger } from '@buddy/core';
import { writeU16le, concatBytes } from '@buddy/core';
import { authenticate, type RandomSource } from './ble-auth';
import { utf8Decode } from './bytes';
import { BLE_INTERVAL_FRAME, CHAR, SERVICE } from './constants';
import { SyaiFailure, failureOf } from './errors';
import { createSyaiGatt, type SyaiGatt } from './gatt';
import { decryptOrg, isVerifiedParseVersion, packetInfo, parseVersionForDevice, recordLength, splitRecords, type DecryptedFrame } from './frames';
import { advertisedMac } from './provisioning';
import { decodeNotifyInfo, describeNotifyInfo } from './notify-info';

export type BatchStatus =
  | { readonly kind: 'packet'; readonly startIndex: number; readonly recordCount: number; readonly surplusPackage: number }
  | { readonly kind: 'complete' };

export interface SessionHandlers {
  onFrame(frame: DecryptedFrame): void;
  onBatch(status: BatchStatus): void;
}

export interface SessionEnv {
  readonly ble: BleTransport;
  readonly clock: Clock;
  readonly log: Logger;
  readonly random: RandomSource;
}

export interface SessionTarget {
  readonly mac: string;
  /** 96 raw bytes. */
  readonly keyGroup: Bytes;
  /** Peripheral id from an earlier connection; tried before scanning. */
  readonly peripheralId: string | null;
}

export interface SessionTimeouts {
  readonly scanMs: number;
  readonly connectMs: number;
}

export const DEFAULT_SESSION_TIMEOUTS: SessionTimeouts = { scanMs: 30_000, connectMs: 15_000 };

const redactMac = (mac: string): string => (mac.length > 4 ? `…${mac.slice(-4)}` : mac);

/** Scans for the sensor advertising `mac`; resolves its peripheral id or null. */
export async function locateSensor(ble: BleTransport, mac: string, timeoutMs: number): Promise<string | null> {
  let found: string | null = null;
  await ble.scan({ services: [SERVICE.cgm], timeoutMs }, (ad) => {
    if (found === null && advertisedMac(ad.manufacturerData) === mac.toUpperCase()) {
      found = ad.id;
      ble.stopScan();
    }
  });
  return found;
}

async function openConnection(env: SessionEnv, target: SessionTarget, t: SessionTimeouts): Promise<BleConnection> {
  const state = await env.ble.state();
  if (state !== 'poweredOn') throw new SyaiFailure('bluetoothUnavailable', `Bluetooth is ${state}`);
  if (target.peripheralId) {
    try {
      return await env.ble.connect(target.peripheralId, { timeoutMs: t.connectMs });
    } catch (e) {
      env.log.info(`Syai: direct connect to ${failureOf(e).message} failed, scanning`);
    }
  }
  const id = await locateSensor(env.ble, target.mac, t.scanMs);
  if (!id) throw new SyaiFailure('noSensorFound', "Couldn't find the sensor over Bluetooth. Make sure it's active and nearby, and that the official Syai app is not connected to it.");
  try {
    return await env.ble.connect(id, { timeoutMs: t.connectMs });
  } catch (e) {
    throw new SyaiFailure('droppedAfterConnect', `Connect failed: ${failureOf(e).message}`);
  }
}

export class SyaiSession {
  /** Resolves once the link is gone, with the platform's error if any. */
  readonly closed: Promise<Error | null>;

  private constructor(
    private readonly conn: BleConnection,
    private readonly gatt: SyaiGatt,
    private readonly unsubscribers: readonly (() => void)[],
    closed: Promise<Error | null>,
    readonly peripheralId: string,
    readonly firmwareVersion: string,
    readonly parseVersion: string,
    /** cmd lifecycle state at connect (0 init, 1 self-test, 2 unactivated, 3 healthy, 4+ dead), null if the read failed. */
    readonly reportedCmdState: number | null,
  ) {
    this.closed = closed;
  }

  static async connect(env: SessionEnv, target: SessionTarget, handlers: SessionHandlers, timeouts: SessionTimeouts = DEFAULT_SESSION_TIMEOUTS): Promise<SyaiSession> {
    const conn = await openConnection(env, target, timeouts);
    let disconnectListener: (e: Error | null) => void = () => {};
    const closed = new Promise<Error | null>((resolve) => {
      disconnectListener = resolve;
    });
    const stopWatching = conn.onDisconnect((e) => disconnectListener(e));
    const gatt = createSyaiGatt(conn);
    const unsubscribers: (() => void)[] = [];
    try {
      const sessionKey = await authenticate(gatt, target.mac, target.keyGroup, env.random);
      const firmwareVersion = await gatt.read(CHAR.softVersion).then(utf8Decode, () => '');
      const parseVersion = parseVersionForDevice(firmwareVersion);
      if (!isVerifiedParseVersion(parseVersion)) {
        env.log.error(`Syai: refusing sensor, firmware "${firmwareVersion}" has no verified glucose decode`);
        throw new SyaiFailure('unsupportedFirmware', `This sensor's firmware (${firmwareVersion || 'unknown'}) isn't supported yet.`);
      }
      await gatt.write(CHAR.ctlDevice, BLE_INTERVAL_FRAME, false).catch((e: unknown) => env.log.info(`Syai: BLE interval setting write failed: ${failureOf(e).message}`));
      const cmd = await gatt.read(CHAR.cmd).then((b) => b[0] ?? null, () => null);
      env.log.info(`Syai: authenticated ${redactMac(target.mac)} fw="${firmwareVersion}" parse=${parseVersion} cmdState=${cmd ?? 'unread'}`);

      const recLen = recordLength(parseVersion);
      const deliver = (notify: Bytes, isHistorical: boolean) => {
        try {
          const org = decryptOrg(notify, sessionKey);
          const records = splitRecords(org, recLen);
          const receivedAt = env.clock.now();
          for (const r of records) handlers.onFrame({ plaintext: r.framed, sequence: r.index, parseVersion, receivedAt, isHistorical });
          if (isHistorical) {
            const info = packetInfo(org);
            handlers.onBatch({ kind: 'packet', startIndex: info.startIndex, recordCount: records.length, surplusPackage: info.surplusPackage });
            if (info.isBatchComplete) handlers.onBatch({ kind: 'complete' });
          }
        } catch (e) {
          env.log.warn(`Syai: frame decode skipped: ${failureOf(e).message}`);
        }
      };
      const onStatus = (data: Bytes) => {
        const frame = decodeNotifyInfo(data);
        env.log.info(frame ? `Syai: ${describeNotifyInfo(frame)}` : `Syai: errorInfo undecodable (${data.length} B)`);
      };
      // errorInfo is a routine status channel; failing to enable it must not fail the session.
      unsubscribers.push(await gatt.subscribe(CHAR.errorInfo, onStatus).catch(() => () => {}));
      unsubscribers.push(await gatt.subscribe(CHAR.newGlucose, (d) => deliver(d, false)));
      unsubscribers.push(await gatt.subscribe(CHAR.glucoseRecord, (d) => deliver(d, true)));
      return new SyaiSession(conn, gatt, unsubscribers, closed, conn.deviceId, firmwareVersion, parseVersion, cmd);
    } catch (e) {
      stopWatching();
      unsubscribers.forEach((u) => u());
      await conn.disconnect().catch(() => {});
      throw e instanceof SyaiFailure ? e : new SyaiFailure('droppedAfterConnect', failureOf(e).message);
    }
  }

  /** Asks the sensor to replay `count` records from `fromIndex` over the history characteristic. */
  async requestHistorical(fromIndex: number, count: number): Promise<void> {
    await this.gatt.write(CHAR.requestByCount, concatBytes(writeU16le(fromIndex), writeU16le(count)), true);
  }

  async disconnect(): Promise<void> {
    this.unsubscribers.forEach((u) => u());
    await this.conn.disconnect().catch(() => {});
  }
}
