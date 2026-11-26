/**
 * Timing policy of the Libre 3 driver. Defaults follow RoundWhiteDiscKit / LibreLoop field-tuned values
 * (MIT, (c) the RoundWhiteDiscKit and LibreLoop authors); tests shrink them.
 */
export interface Libre3Timing {
  readonly scanTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly writeMs: number;
  readonly notifyMs: number;
  readonly commandMs: number;
  /** Silence watchdog tick. */
  readonly watchdogIntervalMs: number;
  /** patchStatus quiet this long: read the characteristic directly. */
  readonly patchStatusReadAfterMs: number;
  /** patchStatus / glucoseData quiet this long: re-arm that notification. */
  readonly rearmAfterMs: number;
  /** No data-plane frame at all this long: drop the link and reconnect. */
  readonly muteResetAfterMs: number;
  /** Wait until no historical page arrived for this long before the clinical request. */
  readonly historicalIdleMs: number;
  readonly historicalMaxWaitMs: number;
  readonly clinicalRetryDelaysMs: readonly number[];
  /** Second historical pass covering the sensor's ~17 minute commit lag. */
  readonly backfillPass2Ms: number;
  /** Backfill request attempts per connection before giving up until the next reconnect. */
  readonly maxBackfillFailures: number;
  /** Consecutive failed authorizations before the status asks for a re-pair via NFC. */
  readonly authFailuresBeforeRepair: number;
  reconnectDelayMs(failures: number): number;
}

/** First retries immediate, then exponential 5 s to 300 s (LibreLoop `reconnectBackoff`). */
export const reconnectBackoff = (failures: number): number => (failures < 3 ? 0 : Math.min(300_000, 5_000 * 2 ** Math.min(failures - 3, 6)));

export const DEFAULT_TIMING: Libre3Timing = {
  scanTimeoutMs: 60_000,
  connectTimeoutMs: 30_000,
  writeMs: 5_000,
  notifyMs: 10_000,
  commandMs: 5_000,
  watchdogIntervalMs: 20_000,
  patchStatusReadAfterMs: 60_000,
  rearmAfterMs: 150_000,
  muteResetAfterMs: 300_000,
  historicalIdleMs: 1_500,
  historicalMaxWaitMs: 15_000,
  clinicalRetryDelaysMs: [0, 2_000, 4_000],
  backfillPass2Ms: 22 * 60_000,
  maxBackfillFailures: 3,
  authFailuresBeforeRepair: 6,
  reconnectDelayMs: reconnectBackoff,
};
