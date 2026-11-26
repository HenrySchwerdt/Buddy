import type { DataStore, Millis } from '@buddy/core';

/** What the post-loop services need from the runtime; passed in so service modules never import runtime.ts. */
export interface ServiceHost {
  readonly store: DataStore;
  now(): Millis;
  /** The demo world has no real services (no uploads, no Health, no calendar). */
  isDemo(): boolean;
  runLoop(): Promise<unknown>;
  /** Remote-control fields for the Nightscout profile (iOS push token etc.); null when remote control is off. */
  remoteProfile?(): Promise<Parameters<typeof import('./services').uploadNightscoutProfile>[1]>;
}
