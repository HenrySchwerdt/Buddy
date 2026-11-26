/**
 * Constants of the Insight Bridge protocol v2 (InsightKit `BridgeProtocol`, PROTOCOL.md).
 * UUIDs are lower-case as `BleTransport` expects.
 */
export const INSIGHT_PROTOCOL_VERSION = 2;

export const BRIDGE_SERVICE_UUID = '2462d0e9-9ba1-4434-8dfe-75d844ac9945';
/** phone -> bridge, write with response */
export const BRIDGE_RX_UUID = '6fafd9dd-5bce-4a1d-b262-a61b50ae7842';
/** bridge -> phone, notify */
export const BRIDGE_TX_UUID = '7edc9323-9bfa-4a7e-afbb-92dee0f0b917';

export const ADVERTISED_NAME_PREFIX = 'InsightBridge-';

/** Maximum reassembled message size (16 KiB). */
export const MAX_MESSAGE_SIZE = 16 * 1024;
/** A partial message is discarded after this long without its LAST fragment. */
export const REASSEMBLY_TIMEOUT_MS = 5_000;

/** Timeouts on the phone side (PROTOCOL.md section 5). */
export interface InsightTimeouts {
  readonly statusMs: number;
  readonly dosingMs: number;
  readonly pingMs: number;
  /** Candidate must finish the session handshake (section 1a). */
  readonly handshakeMs: number;
  /** Scan + connect + handshake for a dosing/status command. */
  readonly connectMs: number;
  readonly scanMs: number;
  readonly pairingResponseMs: number;
  readonly pairingConfirmMs: number;
  /** 0 disables the liveness ping. */
  readonly pingIntervalMs: number;
  /** A candidate that is not the paired bridge is ignored this long. */
  readonly ignoreMs: number;
}

export const DEFAULT_TIMEOUTS: InsightTimeouts = {
  statusMs: 30_000,
  dosingMs: 45_000,
  pingMs: 10_000,
  handshakeMs: 10_000,
  connectMs: 20_000,
  scanMs: 8_000,
  pairingResponseMs: 15_000,
  pairingConfirmMs: 130_000,
  pingIntervalMs: 60_000,
  ignoreMs: 10 * 60_000,
};

/** Status older than this is stale and blocks dosing. */
export const STALE_STATUS_MS = 15 * 60_000;
/** A read time further in the future than this is not believed. */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;
/** A status must have been read this long after a command before it can show the command did not run. */
export const NOT_DELIVERED_SETTLE_MS = 60_000;
/** 50 events keep a page well below the 16 KiB message limit. */
export const HISTORY_PAGE_SIZE = 50;
/** Back-off between `getRequestOutcome` queries while the bridge says `inProgress`. */
export const OUTCOME_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
