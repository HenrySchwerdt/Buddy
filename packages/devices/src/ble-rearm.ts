/**
 * Helpers that keep a BLE driver armed without JavaScript timers.
 *
 * iOS suspends a backgrounded app, and with it every setTimeout. What does keep running is what CoreBluetooth
 * itself manages: a service-filtered scan and a pending connect (both with the `bluetooth-central` background
 * mode). A driver therefore re-arms one of those the moment a link ends, and a protocol-required wait ("do not
 * reconnect for 30 s") is a `NotBefore` gate that is checked when an advertisement arrives, not a sleeping timer.
 */
import type { BleAdvertisement, BleScanOptions, BleTransport, Clock } from '@buddy/core';

/** "Not before" gate: remembers the earliest time a connection attempt is allowed and answers from the clock. */
export class NotBefore {
  private until = 0;

  constructor(private readonly clock: Clock) {}

  /** Nothing is allowed for the next `ms` (a later, longer hold is never shortened by an earlier call). */
  hold(ms: number): void {
    this.until = Math.max(this.until, this.clock.now() + ms);
  }

  /** Forgets any hold. */
  clear(): void {
    this.until = 0;
  }

  get isOpen(): boolean {
    return this.clock.now() >= this.until;
  }
}

/**
 * Scans until `accept` returns true for an advertisement (which also stops the scan) or the scan ends.
 * `options.timeoutMs: null` keeps the scan armed for as long as it takes, which is the point: no JS timer decides
 * when to look again. Resolves with the accepted advertisement, or null when the scan ended without one
 * (`stopScan()` from elsewhere, or the timeout).
 */
export async function scanFirst(ble: BleTransport, options: BleScanOptions, accept: (ad: BleAdvertisement) => boolean): Promise<BleAdvertisement | null> {
  let found: BleAdvertisement | null = null;
  await ble.scan(options, (ad) => {
    if (found || !accept(ad)) return;
    found = ad;
    ble.stopScan();
  });
  return found;
}
