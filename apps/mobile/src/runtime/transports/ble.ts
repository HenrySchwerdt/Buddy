import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { BLE_MANAGER_OPTIONS } from '../background-ble';
import { backgroundTasks } from '../background-tasks';
import { BLE_WAKE_HOLD_MS } from '../task-guard';
import type { BleAdvertisement, BleConnection, BleState, BleTransport, Bytes } from '@buddy/core';

/** react-native-ble-plx speaks base64; drivers speak bytes. */
const toBase64 = (b: Bytes): string => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string | null | undefined): Bytes => (s ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : new Uint8Array());

let manager: BleManager | null = null;
const getManager = () => (manager ??= new BleManager(BLE_MANAGER_OPTIONS));

/**
 * Creates the BLE manager now. CoreBluetooth delivers its state restoration (a relaunch for a pending connect or
 * scan) to the manager created with the restore identifier, so the runtime creates it as early as it can.
 */
export const primeBleManager = (): void => void getManager();

/**
 * Every BLE event (a discovery, a connect, a notification, a disconnect) is a wake-up when the app was suspended,
 * and iOS only grants a short time for it. Each one therefore renews a background task, so a driver can finish
 * reading the value that woke the app before the heartbeat starts the loop. Released 25 s after the last event.
 */
const wakeTask = backgroundTasks.renewable('buddy-ble-wake', BLE_WAKE_HOLD_MS);

async function ensureAndroidPermissions(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return;
  const result = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
  if (Object.values(result).some((r) => r !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error('Bluetooth permission denied');
}

function toConnection(device: Device): BleConnection {
  const m = getManager();
  return {
    deviceId: device.id,
    mtu: device.mtu,
    async read(service, characteristic) {
      const c = await m.readCharacteristicForDevice(device.id, service, characteristic);
      return fromBase64(c.value);
    },
    async write(service, characteristic, data, withResponse) {
      const v = toBase64(data);
      if (withResponse) await m.writeCharacteristicWithResponseForDevice(device.id, service, characteristic, v);
      else await m.writeCharacteristicWithoutResponseForDevice(device.id, service, characteristic, v);
    },
    async subscribe(service, characteristic, onData) {
      const sub: Subscription = m.monitorCharacteristicForDevice(device.id, service, characteristic, (error, c) => {
        if (!error && c?.value) {
          wakeTask.touch();
          onData(fromBase64(c.value));
        }
      });
      return () => sub.remove();
    },
    async subscribeAll(onData) {
      const subs: Subscription[] = [];
      const withServices = await device.discoverAllServicesAndCharacteristics();
      for (const service of await withServices.services()) {
        for (const characteristic of await service.characteristics()) {
          if (!characteristic.isNotifiable && !characteristic.isIndicatable) continue;
          subs.push(
            m.monitorCharacteristicForDevice(device.id, service.uuid, characteristic.uuid, (error, c) => {
              if (error || !c) return;
              wakeTask.touch();
              onData(characteristic.uuid, fromBase64(c.value));
            }),
          );
        }
      }
      return () => subs.forEach((sub) => sub.remove());
    },
    onDisconnect(listener) {
      const sub = m.onDeviceDisconnected(device.id, (error) => {
        wakeTask.touch();
        listener(error ? new Error(error.message) : null);
      });
      return () => sub.remove();
    },
    async disconnect() {
      await m.cancelDeviceConnection(device.id).catch(() => {});
    },
  };
}

/** Ends the running scan promise (and with it a scan that has no timeout). */
let endActiveScan: (() => void) | null = null;
/** Bumped by every `stopScan()`: a scan that was asked for before it, but only got going after it, must not start. */
let stopEpoch = 0;

/** BleTransport backed by react-native-ble-plx (CoreBluetooth / Android BLE). */
export const bleTransport: BleTransport = {
  state: async () => (await getManager().state()).replace(/^./, (c) => c.toLowerCase()) as BleState,
  async scan(options, onAd) {
    const requestedAt = stopEpoch;
    await ensureAndroidPermissions();
    if (requestedAt !== stopEpoch) return; // stopScan() came in while the permission was being checked
    const m = getManager();
    endActiveScan?.();
    await new Promise<void>((resolve, reject) => {
      // A timeout of `null` scans until `stopScan()`: CoreBluetooth keeps it running while iOS has the app suspended.
      const timer = options.timeoutMs === null ? null : setTimeout(() => end(), options.timeoutMs);
      const end = () => {
        if (timer) clearTimeout(timer);
        if (endActiveScan === end) endActiveScan = null;
        void m.stopDeviceScan();
        resolve();
      };
      endActiveScan = end;
      void m.startDeviceScan(options.services?.length ? [...options.services] : null, { allowDuplicates: options.allowDuplicates ?? false }, (error, d) => {
        if (error) {
          if (timer) clearTimeout(timer);
          if (endActiveScan === end) endActiveScan = null;
          reject(new Error(error.message));
          return;
        }
        if (!d) return;
        wakeTask.touch();
        const ad: BleAdvertisement = { id: d.id, name: d.name ?? d.localName ?? null, rssi: d.rssi ?? null, serviceUuids: d.serviceUUIDs ?? [], manufacturerData: d.manufacturerData ? fromBase64(d.manufacturerData) : null };
        onAd(ad);
      });
    });
  },
  stopScan() {
    stopEpoch++;
    if (endActiveScan) endActiveScan();
    else void getManager().stopDeviceScan();
  },
  cancelConnect: (deviceId) => void getManager().cancelDeviceConnection(deviceId).catch(() => {}),
  async connect(deviceId, options) {
    await ensureAndroidPermissions();
    const m = getManager();
    // `timeoutMs: null` is a pending connect: no timeout (CoreBluetooth never gives up; on Android autoConnect does the same).
    const pending = options?.timeoutMs === null;
    let device = await m.connectToDevice(deviceId, pending ? { autoConnect: true } : { timeout: options?.timeoutMs ?? 15_000, autoConnect: false });
    wakeTask.touch();
    if (options?.requestMtu && Platform.OS === 'android') device = await m.requestMTUForDevice(deviceId, options.requestMtu);
    device = await device.discoverAllServicesAndCharacteristics();
    return toConnection(device);
  },
};
