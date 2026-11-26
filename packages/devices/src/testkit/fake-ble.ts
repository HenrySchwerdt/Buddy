import type { BleAdvertisement, BleConnectOptions, BleConnection, BleScanOptions, BleState, BleTransport, Bytes } from '@buddy/core';

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
  /** Every `scan()` call, in order (to prove a scan was re-armed and with which options). */
  readonly scanCalls: readonly BleScanOptions[];
  /** Every `connect()` call, in order. */
  readonly connectCalls: readonly { readonly deviceId: string; readonly options: BleConnectOptions | undefined }[];
  /** A scan is running right now (started and neither stopped nor timed out). */
  isScanning(): boolean;
  /** Peripheral ids with a connect that has not completed (pending connects waiting for the peripheral). */
  pendingConnects(): readonly string[];
  /** Peripheral ids with an established link. */
  connectedIds(): readonly string[];
  /** The peripheral starts advertising: running scans report it (once per call). */
  advertise(id: string): void;
  /** Takes a peripheral out of / back into range. Pending connects to it complete when it returns. */
  setInRange(id: string, inRange: boolean): void;
  /**
   * The peripheral side ends the link (out of range, sensor sleeps). The central's disconnect listeners run
   * synchronously, so a test with frozen timers can see what the driver does without any timer firing.
   */
  dropLink(id: string, error?: Error): void;
  /** The peripheral sends a notification on its current link (any characteristic). */
  notifyFrom(id: string, service: string, characteristic: string, data: Bytes): void;
}

const key = (s: string, c: string) => `${s.toLowerCase()}|${c.toLowerCase()}`;

/** In-memory BLE central for driver tests. Notifications are delivered asynchronously like real BLE. */
export function createFakeBle(state: BleState = 'poweredOn'): FakeBleControls {
  const peripherals = new Map<string, FakePeripheral>();
  const writes: { characteristic: string; data: Bytes }[] = [];
  let dropAfter: number | null = null;
  let failNext = false;
  const scanCalls: BleScanOptions[] = [];
  const connectCalls: { deviceId: string; options: BleConnectOptions | undefined }[] = [];
  /** Running scans: each reports advertisements to its callback and can be ended. */
  const scans = new Set<{ readonly options: BleScanOptions; readonly onAd: (ad: BleAdvertisement) => void; readonly end: () => void }>();
  const outOfRange = new Set<string>();
  const pending = new Map<string, { readonly resume: () => void; readonly cancel: () => void }[]>();
  const links = new Map<string, { readonly link: PeripheralLink; readonly dropNow: (error?: Error) => void }>();
  const wildcard = new Map<string, Set<(characteristic: string, d: Bytes) => void>>();

  const matchesFilter = (p: FakePeripheral, options: BleScanOptions) =>
    !options.services?.length || options.services.some((s) => p.serviceUuids.map((x) => x.toLowerCase()).includes(s.toLowerCase()));
  const adOf = (p: FakePeripheral): BleAdvertisement => ({ id: p.id, name: p.name, rssi: -60, serviceUuids: p.serviceUuids, manufacturerData: p.manufacturerData ?? null });

  /** Completes (or fails) once the peripheral exists, is in range and `cancelConnect` was not called. */
  const waitForPeripheral = (deviceId: string): Promise<FakePeripheral> =>
    new Promise<FakePeripheral>((resolve, reject) => {
      const attempt = () => {
        const p = peripherals.get(deviceId);
        if (!p || outOfRange.has(deviceId)) return false;
        pending.set(deviceId, (pending.get(deviceId) ?? []).filter((w) => w !== waiter));
        resolve(p);
        return true;
      };
      const waiter = {
        resume: () => void attempt(),
        cancel: () => {
          pending.set(deviceId, (pending.get(deviceId) ?? []).filter((w) => w !== waiter));
          reject(new Error('Connection cancelled'));
        },
      };
      if (attempt()) return;
      pending.set(deviceId, [...(pending.get(deviceId) ?? []), waiter]);
    });

  const transport: BleTransport = {
    state: async () => state,
    async scan(options, onAd) {
      scanCalls.push(options);
      let finish: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timer = options.timeoutMs === null ? null : setTimeout(finish, Math.min(options.timeoutMs, 5));
      const entry = {
        options,
        onAd,
        end: () => {
          if (timer) clearTimeout(timer);
          finish();
        },
      };
      scans.add(entry);
      for (const p of peripherals.values()) if (!outOfRange.has(p.id) && matchesFilter(p, options)) onAd(adOf(p));
      await done;
      scans.delete(entry);
    },
    stopScan: () => [...scans].forEach((sc) => sc.end()),
    cancelConnect: (deviceId) => [...(pending.get(deviceId) ?? [])].forEach((w) => w.cancel()),
    async connect(deviceId, connectOptions) {
      connectCalls.push({ deviceId, options: connectOptions });
      let p = peripherals.get(deviceId);
      if (connectOptions?.timeoutMs === null) p = await waitForPeripheral(deviceId);
      else if (!p || outOfRange.has(deviceId)) throw new Error(`No peripheral ${deviceId}`);
      if (!p) throw new Error(`No peripheral ${deviceId}`);
      const subs = new Map<string, Set<(d: Bytes) => void>>();
      const dcListeners = new Set<(e: Error | null) => void>();
      let connected = true;
      const link: PeripheralLink = {
        notify(s, c, data) {
          if (!connected) return;
          const copy = data.slice();
          setTimeout(() => {
            subs.get(key(s, c))?.forEach((cb) => cb(copy));
            wildcard.get(deviceId)?.forEach((cb) => cb(c, copy));
          }, 0);
        },
        disconnect(error) {
          if (!connected) return;
          connected = false;
          if (links.get(deviceId)?.link === link) links.delete(deviceId);
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
        async subscribeAll(onData) {
          ensure();
          const set = wildcard.get(deviceId) ?? new Set();
          wildcard.set(deviceId, set);
          set.add(onData);
          return () => set.delete(onData);
        },
        onDisconnect(l) {
          dcListeners.add(l);
          return () => dcListeners.delete(l);
        },
        async disconnect() {
          link.disconnect();
        },
      };
      links.set(deviceId, {
        link,
        dropNow(error) {
          if (!connected) return;
          connected = false;
          links.delete(deviceId);
          dcListeners.forEach((l) => l(error ?? null));
        },
      });
      p.onConnect?.(link);
      return conn;
    },
  };

  return {
    transport,
    add: (p) => {
      peripherals.set(p.id, p);
      pending.get(p.id)?.forEach((w) => w.resume());
    },
    dropAfterWrites: (n) => {
      dropAfter = n;
    },
    failNextWrite: () => {
      failNext = true;
    },
    writes,
    scanCalls,
    connectCalls,
    isScanning: () => scans.size > 0,
    pendingConnects: () => [...pending.entries()].filter(([, w]) => w.length > 0).map(([id]) => id),
    connectedIds: () => [...links.keys()],
    advertise(id) {
      const p = peripherals.get(id);
      if (!p || outOfRange.has(id)) return;
      for (const sc of [...scans]) if (matchesFilter(p, sc.options)) sc.onAd(adOf(p));
    },
    setInRange(id, inRange) {
      if (inRange) {
        outOfRange.delete(id);
        pending.get(id)?.forEach((w) => w.resume());
      } else outOfRange.add(id);
    },
    dropLink: (id, error) => links.get(id)?.dropNow(error ?? new Error('Link lost')),
    notifyFrom: (id, service, characteristic, data) => links.get(id)?.link.notify(service, characteristic, data),
  };
}
