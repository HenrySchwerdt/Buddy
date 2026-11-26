/**
 * RileyLink discovery for the pump setup: lists the RileyLinks (and compatible bridges) in range
 * with their name and signal strength.
 */
import type { BleTransport } from '@buddy/core';
import { scanRileyLinks, type RileyLinkAdvertisement } from '../../rileylink';

export type { RileyLinkAdvertisement };

const DEFAULT_SCAN_MS = 8_000;

/** Resolves with every RileyLink seen during the scan; `onFound` reports each new one as it appears. */
export const scanForRileyLinks = (ble: BleTransport, o: { readonly timeoutMs?: number; readonly onFound?: (ad: RileyLinkAdvertisement) => void } = {}): Promise<readonly RileyLinkAdvertisement[]> =>
  scanRileyLinks(ble, { timeoutMs: o.timeoutMs ?? DEFAULT_SCAN_MS, onFound: o.onFound });
