/**
 * Connection establishment: TypeScript port of the scan/connect/handshake parts of
 * DanaKit/PumpManager/BluetoothManager.swift and InteractiveBluetoothManager.swift, plus the
 * RSv3 PIN parsing of DanaKitUI/ViewModels/DanaKitScanViewModel.swift (`processPinPrompt`), from
 * loopandlearn/DanaKit (MIT, © 2021 Randall Knutson and the DanaKit authors).
 */
import { fromHex, type BleConnection, type BleTransport, type Bytes, type Logger } from '@buddy/core';
import { DanaPeripheral, DANA_SERVICE, type ConnectionResult, type DanaNotification, type DanaSessionState } from './peripheral';

export const DEVICE_NAME_REGEX = /^[a-zA-Z]{3}[0-9]{5}[a-zA-Z]{2}$/;

export interface DanaTimeouts {
  /** "throw error if device could not be found after 10 sec" */
  readonly scanMs: number;
  /** `startTimeout(seconds: 15)` — connect + encryption handshake. */
  readonly connectMs: number;
  /** How long a connect() waits for `providePincode()` while the pump shows the RSv3 PINs. */
  readonly pairingMs: number;
  /** Per-command response timeout (DanaKit: 4 s). */
  readonly commandMs: number;
}

export const DEFAULT_TIMEOUTS: DanaTimeouts = { scanMs: 10_000, connectMs: 15_000, pairingMs: 120_000, commandMs: 4_000 };

export interface DanaLink {
  readonly conn: BleConnection;
  readonly peripheral: DanaPeripheral;
}

export interface Pincodes {
  readonly pairingKey: Bytes;
  readonly randomPairingKey: Bytes;
}

/**
 * `processPinPrompt`: PIN 1 is 12 hex characters (pairing key), PIN 2 is 8 hex characters
 * (3-byte random pairing key + 1-byte XOR checksum over both keys).
 */
export function parsePincodes(pin1: string, pin2: string): Pincodes | { error: string } {
  const p1 = pin1.trim();
  const p2 = pin2.trim();
  if (p1.length !== 12 || p2.length !== 8) return { error: 'Received invalid pincode lengths. Try again' };
  if (!/^[0-9a-f]+$/i.test(p1) || !/^[0-9a-f]+$/i.test(p2)) return { error: 'Received invalid hex strings. Try again' };

  const pairingKey = fromHex(p1);
  const b2 = fromHex(p2);
  const randomPairingKey = b2.slice(0, 3);
  const checkSum = b2[3];

  let pairingKeyCheckSum = 0;
  for (const byte of pairingKey) pairingKeyCheckSum ^= byte;
  for (const byte of randomPairingKey) pairingKeyCheckSum ^= byte;

  if (checkSum !== pairingKeyCheckSum) return { error: 'Checksum failed. Try again' };
  return { pairingKey, randomPairingKey };
}

export interface OpenLinkDeps {
  readonly ble: BleTransport;
  readonly log: Logger;
  readonly session: DanaSessionState;
  readonly timeouts: DanaTimeouts;
  readonly knownBleId: string | null;
  onKeysChanged(): void;
  onNotification(n: DanaNotification): void;
  onDisconnect(conn: BleConnection, error: Error | null): void;
  /** Resolves with the PINs the user typed, or rejects when pairing is abandoned. */
  awaitPincode(): Promise<Pincodes>;
}

/** Scans for the advertised device name (`bleCentralManager(_:didDiscover:)`). */
export async function findPump(ble: BleTransport, deviceName: string, timeoutMs: number): Promise<string | null> {
  let found: string | null = null;
  const wanted = deviceName.toUpperCase();
  await ble.scan({ timeoutMs }, (ad) => {
    if (found || !ad.name || !DEVICE_NAME_REGEX.test(ad.name) || ad.name.toUpperCase() !== wanted) return;
    found = ad.id;
    ble.stopScan();
  });
  return found;
}

const withTimeout = <T>(p: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** Connects, runs the encryption handshake (incl. RSv3 PIN pairing) and returns the ready link. */
export async function openLink(deps: OpenLinkDeps): Promise<{ link: DanaLink; bleId: string }> {
  const { ble, log, session, timeouts } = deps;
  const state = await ble.state();
  if (state !== 'poweredOn') throw new Error(`Invalid bluetooth state - state: ${state}`);

  let bleId = deps.knownBleId;
  let conn: BleConnection | null = null;
  if (bleId) {
    conn = await ble.connect(bleId, { timeoutMs: timeouts.connectMs }).catch((e: unknown) => {
      log.warn(`Dana: direct connect to stored peripheral failed (${String(e)}), scanning`);
      return null;
    });
  }
  if (!conn) {
    bleId = await findPump(ble, session.deviceName, timeouts.scanMs);
    if (!bleId) throw new Error('Device is not findable');
    conn = await ble.connect(bleId, { timeoutMs: timeouts.connectMs });
  }
  const connection = conn;

  session.isConnected = false;
  // `completion(ConnectionResult)` may fire more than once (requestedPincode, then success)
  let waiter: ((r: ConnectionResult) => void) | null = null;
  const queued: ConnectionResult[] = [];
  const deliver = (r: ConnectionResult) => {
    const w = waiter;
    waiter = null;
    if (w) w(r);
    else queued.push(r);
  };
  const nextResult = () =>
    new Promise<ConnectionResult>((resolve) => {
      const q = queued.shift();
      if (q) resolve(q);
      else waiter = resolve;
    });

  const peripheral = new DanaPeripheral(connection, session, {
    log,
    onConnectionResult: deliver,
    onKeysChanged: deps.onKeysChanged,
    onNotification: deps.onNotification,
  });

  let dropped = false;
  const offDisconnect = connection.onDisconnect((error) => {
    dropped = true;
    peripheral.close(error ?? new Error('Disconnected'));
    deliver({ kind: 'failure', error: error ?? new Error('Disconnected during handshake') });
    deps.onDisconnect(connection, error);
  });

  const fail = async (error: Error): Promise<never> => {
    offDisconnect();
    peripheral.close(error);
    await connection.disconnect().catch(() => {});
    session.isConnected = false;
    throw error;
  };

  try {
    const first = nextResult();
    await withTimeout(peripheral.start(), timeouts.connectMs, 'Failed to connect: Timeout reached...');
    let result = await withTimeout(first, timeouts.connectMs, 'Failed to connect: Timeout reached...');

    if (result.kind === 'requestedPincode') {
      log.info('Dana: pump requests RSv3 pairing — waiting for the PINs shown on the pump');
      const pins = await withTimeout(deps.awaitPincode(), timeouts.pairingMs, 'Pairing timed out: no PIN entered');
      const next = nextResult();
      peripheral.finishV3Pairing(pins.pairingKey, pins.randomPairingKey);
      result = await withTimeout(next, timeouts.connectMs, 'Failed to connect: Timeout reached...');
    }

    if (result.kind === 'invalidBle5Keys') return await fail(new Error('Invalid BLE-5 keys. Please unbond the pump in the phone settings and pair again.'));
    if (result.kind === 'failure') return await fail(result.error);
    if (result.kind !== 'success') return await fail(new Error('Unexpected pairing request'));
    if (dropped) return await fail(new Error('Disconnected during handshake'));
  } catch (e) {
    return await fail(e instanceof Error ? e : new Error(String(e)));
  }

  log.info(`Dana: connected to ${session.deviceName} (service ${DANA_SERVICE})`);
  return { link: { conn: connection, peripheral }, bleId: bleId ?? connection.deviceId };
}
