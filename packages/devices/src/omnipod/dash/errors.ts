/**
 * Error types of the DASH driver. Condenses `PodProtocolError`, `PeripheralManagerError` and
 * `PodCommsError` of OmnipodKit (MIT License, (c) LoopKit Authors).
 */
import type { PodFault } from '../common';

export type OmnipodErrorKind =
  /** the link is gone or was never up */
  | 'notConnected'
  /** nothing was sent: the pod certainly did not receive the command */
  | 'unsent'
  /** the command may have reached the pod (the answer or the last acknowledgement is missing) */
  | 'unacknowledged'
  /** malformed or unexpected data from the pod */
  | 'protocol'
  | 'pairing'
  | 'session'
  | 'timeout'
  | 'nack'
  | 'podFault'
  | 'rejected'
  | 'incompatible'
  | 'busy'
  | 'invalid';

export class OmnipodError extends Error {
  constructor(
    readonly kind: OmnipodErrorKind,
    message: string,
    readonly fault?: PodFault,
  ) {
    super(message);
    this.name = 'OmnipodError';
  }
}

export const isOmnipodError = (e: unknown, ...kinds: OmnipodErrorKind[]): e is OmnipodError =>
  e instanceof OmnipodError && (kinds.length === 0 || kinds.includes(e.kind));

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
