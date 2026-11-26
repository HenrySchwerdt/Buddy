/**
 * Helpers for the app's setup UI as plain functions (same shape as the Omnipod Eros helpers).
 *
 * Typical flow: pick a RileyLink (`scanForRileyLinks`), enter the pump serial and region, then
 * `refreshMinimed` to read the pump (model, reservoir, battery, limits). When the pump does not
 * answer, `tuneMinimedRadio` scans the region's channels for it.
 */
import type { PumpDriver } from '@buddy/core';
import { MinimedDriver, type MinimedPumpStatus } from './driver';

export const isMinimedDriver = (d: PumpDriver): d is MinimedDriver => d instanceof MinimedDriver;

/** What the driver knows from the last sync, no radio traffic. */
export const readMinimedStatus = (d: MinimedDriver): Promise<MinimedPumpStatus> => d.pumpStatus();
/** Connects the RileyLink if needed and reads the pump (history included). */
export const refreshMinimed = (d: MinimedDriver): Promise<{ ok: true } | { ok: false; error: string }> => d.refresh();
/** Scans the region's channels and remembers the one with the best signal. */
export const tuneMinimedRadio = (d: MinimedDriver): Promise<{ ok: true; frequencyMhz: number } | { ok: false; error: string }> => d.tune();
