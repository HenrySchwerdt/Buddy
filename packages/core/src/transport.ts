/**
 * Hardware transports. Drivers depend only on these interfaces; the app injects a
 * react-native-ble-plx / NFC implementation and tests inject in-memory fakes, so every
 * driver's protocol logic runs in plain Node tests.
 */

export type Bytes = Uint8Array;

export type BleState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'resetting' | 'unknown';

export interface BleAdvertisement {
  readonly id: string;
  readonly name: string | null;
  readonly rssi: number | null;
  readonly serviceUuids: readonly string[];
  readonly manufacturerData: Bytes | null;
}

export interface BleScanOptions {
  /** Only report peripherals advertising one of these services (lower-case 128-bit UUIDs). */
  readonly services?: readonly string[];
  readonly timeoutMs: number;
}

export interface BleConnection {
  readonly deviceId: string;
  /** Negotiated ATT MTU (payload per write is mtu − 3). */
  readonly mtu: number;
  read(service: string, characteristic: string): Promise<Bytes>;
  write(service: string, characteristic: string, data: Bytes, withResponse: boolean): Promise<void>;
  /** Subscribes to notifications/indications; returns an unsubscribe function. */
  subscribe(service: string, characteristic: string, onData: (data: Bytes) => void): Promise<() => void>;
  onDisconnect(listener: (error: Error | null) => void): () => void;
  disconnect(): Promise<void>;
}

export interface BleTransport {
  state(): Promise<BleState>;
  /** Resolves when the timeout elapses or `stopScan` is called. */
  scan(options: BleScanOptions, onAdvertisement: (ad: BleAdvertisement) => void): Promise<void>;
  stopScan(): void;
  connect(deviceId: string, options?: { readonly timeoutMs?: number; readonly requestMtu?: number }): Promise<BleConnection>;
}

/** ISO 15693 NFC (Libre sensors). */
export interface NfcTransport {
  isSupported(): Promise<boolean>;
  /** Runs `session` while a tag is in range; the session ends when the callback resolves. */
  withIso15693Tag<T>(alertMessage: string, session: (tag: NfcIso15693Tag) => Promise<T>): Promise<T>;
}

export interface NfcIso15693Tag {
  readonly uid: Bytes;
  /** Sends a raw ISO 15693 command (flags + command code + params) and returns the response. */
  transceive(command: Bytes): Promise<Bytes>;
  /** Manufacturer custom command (e.g. Abbott 0xA1). */
  customCommand(code: number, params: Bytes): Promise<Bytes>;
  readSingleBlock(block: number): Promise<Bytes>;
}

/** Small persistent key/value store for pairing keys, sensor serials, etc. (keychain-backed in the app). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      if (v === null) map.delete(k);
      else map.set(k, v);
    },
  };
}

// ── byte helpers shared by drivers ─────────────────────────────────────────────

export const hex = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function fromHex(s: string): Bytes {
  const clean = s.replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2) throw new Error(`Odd-length hex: ${s}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const concatBytes = (...parts: readonly Bytes[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const u16le = (b: Bytes, o: number): number => (b[o]! | (b[o + 1]! << 8)) >>> 0;
export const u32le = (b: Bytes, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
export const i16le = (b: Bytes, o: number): number => (u16le(b, o) << 16) >> 16;
export const u16be = (b: Bytes, o: number): number => ((b[o]! << 8) | b[o + 1]!) >>> 0;
export const u32be = (b: Bytes, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export const writeU16le = (v: number): Bytes => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
export const writeU32le = (v: number): Bytes => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — used by Dexcom and others. */
export function crc16CcittFalse(data: Bytes, init = 0xffff): number {
  let crc = init;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
