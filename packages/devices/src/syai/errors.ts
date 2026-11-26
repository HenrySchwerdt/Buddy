/**
 * Failure taxonomy of the Syai driver. Mirrors `SyaiPairingService.Failure` and
 * `SyaiEnvelopedClient.TransportError` from SyaiKit (MIT, © 2026 Nightscout Foundation).
 */
export type SyaiFailureKind =
  /** The sensor was not seen while scanning (out of range, asleep, or the official app holds the link). */
  | 'noSensorFound'
  /** The link dropped after a successful connect. Strong "it is right here" signal: retry fast. */
  | 'droppedAfterConnect'
  /** Firmware whose readings cannot be decoded; raised before anything is written to the sensor. */
  | 'unsupportedFirmware'
  | 'noKeyGroup'
  /** The sensor does not hold the key group (its auth signature did not verify). */
  | 'authFailed'
  | 'bluetoothUnavailable'
  /** Sensor record from the account is missing something the decode depends on. */
  | 'noCalibration'
  | 'notConfigured'
  /** The account was signed in elsewhere, which revoked this session. Not retryable. */
  | 'accountLoggedOutElsewhere'
  | 'accountRejected'
  | 'network';

export class SyaiFailure extends Error {
  constructor(
    readonly kind: SyaiFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'SyaiFailure';
  }
}

export const failureOf = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** A non-2xx answer from the Syai server (or a business code inside a 200). */
export class SyaiHttpError extends SyaiFailure {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super('network', `Syai HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'SyaiHttpError';
  }

  get code(): string | null {
    try {
      const c = (JSON.parse(this.body) as { code?: unknown }).code;
      return typeof c === 'string' ? c : null;
    } catch {
      return null;
    }
  }

  /** Session invalidated by a login elsewhere (e.g. the official app): a re-login would just evict that session. */
  get isLoggedInElsewhere(): boolean {
    return this.status === 401 && this.code === 'AuthFailed_LoginElsewhere';
  }

  /** A dead/expired token: the only error that may trigger a silent re-login. */
  get isAuthFailure(): boolean {
    return (this.status === 401 || this.status === 403) && !this.isLoggedInElsewhere;
  }
}
