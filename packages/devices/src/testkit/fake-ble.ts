import type { BleAdvertisement, BleConnection, BleState, BleTransport, Bytes } from '@buddy/core';

/** Behaviour of a simulated peripheral (implemented by each driver's protocol simulator). */
export interface FakePeripheral {
  readonly id: string;
  readonly name: string | null;
  readonly serviceUuids: readonly string[];
  readonly manufacturerData?: Bytes | null;
  readonly mtu?: number;
  onConnect?(link: PeripheralLink): void;
  onWrite(service: string, characteristic: string, data: Bytes, link: PeripheralLink): void | Promise<void>;
  onRead?(service: string, characteristic: string, link: PeripheralLink): Bytes | Promise<Bytes>;
  onSubscribe?(service: string, characteristic: string, link: PeripheralLink): void;
}

/** What a simulated peripheral can do back to the central. */
export interface PeripheralLink {
  notify(service: string, characteristic: string, data: Bytes): void;
  disconnect(error?: Error): void;
}

export interface FakeBleControls {
  readonly transport: BleTransport;
  add(peripheral: FakePeripheral): void;
  /** Fault injection: the connection drops right after the next `n`-th write reaches the peripheral. */
  dropAfterWrites(n: number): void;
  /** Fault injection: the next write fails before reaching the peripheral. */
  failNextWrite(): void;
  readonly writes: readonly { characteristic: string; data: Bytes }[];
}

const key = (s: string, c: string) => `${s.toLowerCase()}|${c.toLowerCase()}`;

/** In-memory BLE central for driver tests. Notifications are delivered asynchronously like real BLE. */
export function createFakeBle(state: BleState = 'poweredOn'): FakeBleControls {
  const peripherals = new Map<string, FakePeripheral>();
  const writes: { characteristic: string; data: Bytes }[] = [];
  let dropAfter: number | null = null;
  let failNext = false;
  let scanning: (() => void) | null = null;

  const transport: BleTransport = {
    state: async () => state,
    async scan(options, onAd) {
      for (const p of peripherals.values()) {
        if (options.services?.length && !options.services.some((s) => p.serviceUuids.map((x) => x.toLowerCase()).includes(s.toLowerCase()))) continue;
        const ad: BleAdvertisement = { id: p.id, name: p.name, rssi: -60, serviceUuids: p.serviceUuids, manufacturerData: p.manufacturerData ?? null };
        onAd(ad);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(options.timeoutMs, 5));
        scanning = () => {
          clearTimeout(t);
          resolve();
        };
      });
      scanning = null;
    },
    stopScan: () => scanning?.(),
    async connect(deviceId) {
      const p = peripherals.get(deviceId);
      if (!p) throw new Error(`No peripheral ${deviceId}`);
      const subs = new Map<string, Set<(d: Bytes) => void>>();
      const dcListeners = new Set<(e: Error | null) => void>();
      let connected = true;
      const link: PeripheralLink = {
        notify(s, c, data) {
          if (!connected) return;
          const copy = data.slice();
          setTimeout(() => subs.get(key(s, c))?.forEach((cb) => cb(copy)), 0);
        },
        disconnect(error) {
          if (!connected) return;
          connected = false;
          setTimeout(() => dcListeners.forEach((l) => l(error ?? null)), 0);
        },
      };
      const ensure = () => {
        if (!connected) throw new Error('Peripheral disconnected');
      };
      const conn: BleConnection = {
        deviceId,
        mtu: p.mtu ?? 185,
        async read(s, c) {
          ensure();
          if (!p.onRead) throw new Error('Characteristic not readable');
          return (await p.onRead(s, c, link)).slice();
        },
        async write(s, c, data) {
          ensure();
          if (failNext) {
            failNext = false;
            throw new Error('Write failed (injected)');
          }
          writes.push({ characteristic: c, data: data.slice() });
          await p.onWrite(s, c, data.slice(), link);
          if (dropAfter !== null && --dropAfter <= 0) {
            dropAfter = null;
            link.disconnect(new Error('Connection lost (injected)'));
          }
        },
        async subscribe(s, c, onData) {
          ensure();
          const k = key(s, c);
          if (!subs.has(k)) subs.set(k, new Set());
          subs.get(k)!.add(onData);
          p.onSubscribe?.(s, c, link);
          return () => subs.get(k)?.delete(onData);
        },
        onDisconnect(l) {
          dcListeners.add(l);
          return () => dcListeners.delete(l);
        },
        async disconnect() {
          link.disconnect();
        },
      };
      p.onConnect?.(link);
      return conn;
    },
  };

  return {
    transport,
    add: (p) => void peripherals.set(p.id, p),
    dropAfterWrites: (n) => {
      dropAfter = n;
    },
    failNextWrite: () => {
      failNext = true;
    },
    writes,
  };
}
