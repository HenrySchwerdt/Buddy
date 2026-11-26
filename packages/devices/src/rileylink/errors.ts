/**
 * TypeScript port of `RileyLinkDeviceError` / `PeripheralManagerError` from RileyLinkBLEKit
 * (RileyLinkKit, MIT License, (c) Pete Schwamb).
 */
import type { Bytes } from '@buddy/core';

export type RileyLinkErrorKind =
  /** The radio heard nothing in time (rxTimeout / commandInterrupted). `retry` is usually safe. */
  | 'responseTimeout'
  /** BLE works but the RileyLink never answered the command: the command channel is hung. */
  | 'commandsBlocked'
  /** The RileyLink answered with something we cannot use (zeroData, unparsable, missing packet). */
  | 'invalidResponse'
  /** The RileyLink reported invalidParam / unknownCommand. */
  | 'errorResponse'
  | 'writeSizeLimitExceeded'
  /** Firmware too old for the command. */
  | 'unsupportedCommand'
  /** A BLE read/write failed or timed out before the write was confirmed. */
  | 'bleError'
  | 'disconnected';

export class RileyLinkError extends Error {
  constructor(
    readonly kind: RileyLinkErrorKind,
    message: string,
    readonly data?: Bytes,
  ) {
    super(message);
    this.name = 'RileyLinkError';
  }
}

export const isRileyLinkError = (e: unknown, kind?: RileyLinkErrorKind): e is RileyLinkError =>
  e instanceof RileyLinkError && (kind === undefined || e.kind === kind);

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
