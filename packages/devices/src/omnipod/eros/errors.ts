/**
 * Errors of the Eros message transport; mirrors the `PodCommsError` cases that
 * `ErosMessageTransport.swift` (OmnipodKit, MIT License, (c) LoopKit Authors) throws.
 */
export type ErosTransportErrorKind =
  /** The pod never answered a packet within the exchange timeout. Nothing is known about delivery. */
  | 'noResponseRL'
  | 'podAckedInsteadOfReturningResponse'
  | 'unexpectedPacketType'
  | 'emptyResponse'
  | 'invalidCrc'
  | 'invalidAddress'
  | 'invalidSequence'
  /** The full message was sent but no valid response arrived: the pod may have executed it. `cause` has the reason. */
  | 'unacknowledgedMessage'
  | 'commsError'
  /** The message bytes passed in are malformed; nothing was sent. */
  | 'invalidMessage';

export class ErosTransportError extends Error {
  constructor(
    readonly kind: ErosTransportErrorKind,
    message: string,
    readonly cause?: unknown,
    readonly sequenceNumber?: number,
  ) {
    super(message);
    this.name = 'ErosTransportError';
  }

  /** The kind of the underlying error for `unacknowledgedMessage`, else this error's own kind. */
  get rootKind(): ErosTransportErrorKind {
    return this.kind === 'unacknowledgedMessage' && this.cause instanceof ErosTransportError ? this.cause.kind : this.kind;
  }
}
