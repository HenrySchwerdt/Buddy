import type { Millis } from '@buddy/core';

/** One reading as handed over by the native bridge (Android broadcast) or parsed from the iOS app-group JSON. */
export interface XdripNativeReading {
  /** mg/dL (xDrip4iOS `Value`, xDrip+ `BgEstimate`). */
  readonly value: number;
  /** Epoch ms of the measurement (never the time Buddy received it). */
  readonly date: Millis;
  /** xDrip direction name ("Flat", "FortyFiveUp", ...), when known. */
  readonly direction?: string;
  /** Numeric trend (LoopKit `GlucoseTrend` raw value, 1 = double up ... 7 = double down), when no name is available. */
  readonly trend?: number;
}

/**
 * Native side of the xDrip source, injected by the app (see apps/mobile/modules/xdrip-bridge). The plugin never
 * touches platform APIs, so it is tested with an in-memory fake.
 */
export interface XdripBridge {
  readonly platform: 'ios' | 'android';
  /** False when the native side cannot work yet (iOS: no App Group id configured / entitlement missing). */
  isConfigured(): Promise<boolean>;
  /** iOS: raw bytes of the app-group key `latestReadings` as a UTF-8 string, or null when nothing was shared yet. */
  readAppGroupJson?(): Promise<string | null>;
  /** Android: readings buffered by the native BroadcastReceiver (including those received while JS was not running). */
  bufferedReadings?(): Promise<readonly XdripNativeReading[]>;
  /** Android: live readings as the broadcast arrives. Returns the unsubscribe function. */
  subscribe?(listener: (reading: XdripNativeReading) => void): () => void;
}

/** `ctx` as the app builds it: the standard `DeviceContext` plus the native xDrip bridge. */
export interface XdripContextExtension {
  readonly xdrip?: XdripBridge;
}
