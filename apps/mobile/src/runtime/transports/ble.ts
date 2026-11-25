import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import type { BleAdvertisement, BleConnection, BleState, BleTransport, Bytes } from '@buddy/core';

/** react-native-ble-plx speaks base64; drivers speak bytes. */
const toBase64 = (b: Bytes): string => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string | null | undefined): Bytes => (s ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : new Uint8Array());

let manager: BleManager | null = null;
const getManager = () => (manager ??= new BleManager());

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
        if (!error && c?.value) onData(fromBase64(c.value));
      });
      return () => sub.remove();
    },
    onDisconnect(listener) {
      const sub = m.onDeviceDisconnected(device.id, (error) => listener(error ? new Error(error.message) : null));
      return () => sub.remove();
    },
    async disconnect() {
      await m.cancelDeviceConnection(device.id).catch(() => {});
    },
  };
}

/** BleTransport backed by react-native-ble-plx (CoreBluetooth / Android BLE). */
export const bleTransport: BleTransport = {
  state: async () => (await getManager().state()).replace(/^./, (c) => c.toLowerCase()) as BleState,
  async scan(options, onAd) {
    await ensureAndroidPermissions();
    const m = getManager();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void m.stopDeviceScan();
        resolve();
      }, options.timeoutMs);
      void m.startDeviceScan(options.services?.length ? [...options.services] : null, { allowDuplicates: false }, (error, d) => {
        if (error) {
          clearTimeout(timer);
          reject(new Error(error.message));
          return;
        }
        if (!d) return;
        const ad: BleAdvertisement = { id: d.id, name: d.name ?? d.localName ?? null, rssi: d.rssi ?? null, serviceUuids: d.serviceUUIDs ?? [], manufacturerData: d.manufacturerData ? fromBase64(d.manufacturerData) : null };
        onAd(ad);
      });
    });
  },
  stopScan: () => void getManager().stopDeviceScan(),
  async connect(deviceId, options) {
    await ensureAndroidPermissions();
    const m = getManager();
    let device = await m.connectToDevice(deviceId, { timeout: options?.timeoutMs ?? 15_000, autoConnect: false });
    if (options?.requestMtu && Platform.OS === 'android') device = await m.requestMTUForDevice(deviceId, options.requestMtu);
    device = await device.discoverAllServicesAndCharacteristics();
    return toConnection(device);
  },
};
