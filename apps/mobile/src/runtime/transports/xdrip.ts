import { Platform } from 'react-native';
import type { XdripBridge, XdripNativeReading } from '@buddy/devices';
import { XdripBridgeNative, type NativeXdripReading } from '../../../modules/xdrip-bridge';

const toReading = (r: NativeXdripReading): XdripNativeReading => ({ value: r.value, date: r.date, ...(r.direction ? { direction: r.direction } : {}) });

/** XdripBridge backed by the local `xdrip-bridge` Expo module; undefined where the module is not linked (web, Expo Go). */
export const xdripBridge: XdripBridge | undefined = (() => {
  const native = XdripBridgeNative;
  if (!native || (Platform.OS !== 'ios' && Platform.OS !== 'android')) return undefined;
  const bridge: XdripBridge = {
    platform: Platform.OS,
    isConfigured: () => native.isConfigured(),
    ...(Platform.OS === 'ios' && native.readAppGroupJson ? { readAppGroupJson: () => native.readAppGroupJson!() } : {}),
    ...(Platform.OS === 'android' && native.bufferedReadings
      ? {
          bufferedReadings: async () => (await native.bufferedReadings!()).map(toReading),
          subscribe: (listener: (r: XdripNativeReading) => void) => {
            const sub = native.addListener?.('onReading', (r) => listener(toReading(r)));
            return () => sub?.remove();
          },
        }
      : {}),
  };
  return bridge;
})();
