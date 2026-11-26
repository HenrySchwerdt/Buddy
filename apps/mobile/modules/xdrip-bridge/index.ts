import { requireOptionalNativeModule } from 'expo';

/** Wire shape of a reading from the Android receiver (iOS returns raw JSON instead). */
export interface NativeXdripReading {
  readonly value: number;
  readonly date: number;
  readonly direction?: string | null;
}

interface XdripBridgeNative {
  isConfigured(): Promise<boolean>;
  /** iOS only. */
  getAppGroupId?(): Promise<string | null>;
  /** iOS only. */
  readAppGroupJson?(): Promise<string | null>;
  /** Android only. */
  bufferedReadings?(): Promise<NativeXdripReading[]>;
  /** Android only (EventEmitter). */
  addListener?(event: 'onReading', listener: (r: NativeXdripReading) => void): { remove(): void };
}

/** Null on web, in Expo Go, or in a build made before the module was added. */
export const XdripBridgeNative = requireOptionalNativeModule<XdripBridgeNative>('XdripBridge');
