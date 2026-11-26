/**
 * Security-phase transport over a BLE connection: fragmented writes to the certificate/challenge
 * characteristics, the single-byte command channel and notify reassembly.
 *
 * TypeScript port of RoundWhiteDiscKit `Pairing/PairingTransport.swift` and
 * `Pairing/SensorSessionTransport.swift` (MIT, (c) the RoundWhiteDiscKit authors).
 */
import type { BleConnection, Bytes } from '@buddy/core';
import { LIBRE3_CHAR, LIBRE3_SECURITY_SERVICE } from './constants';
import { fragmentForWrite, NotifyReassembler } from './framing';
import { Mailbox } from './mailbox';

export interface LinkTimeouts {
  readonly writeMs: number;
  readonly notifyMs: number;
  readonly commandMs: number;
}

export const DEFAULT_LINK_TIMEOUTS: LinkTimeouts = { writeMs: 5_000, notifyMs: 10_000, commandMs: 5_000 };

export class WriteTimeoutError extends Error {
  constructor(readonly label: string, ms: number) {
    super(`GATT write "${label}" timed out after ${ms} ms`);
    this.name = 'WriteTimeoutError';
  }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type SecurityChannel = 'certData' | 'challengeData';

export class SecurityLink {
  constructor(
    private readonly conn: BleConnection,
    private readonly mailbox: Mailbox,
    private readonly timeouts: LinkTimeouts = DEFAULT_LINK_TIMEOUTS,
  ) {}

  /** Enables notifications on the three security characteristics; returns the cleanup function. */
  async open(): Promise<() => void> {
    const cleanups: (() => void)[] = [];
    for (const key of ['certData', 'challengeData', 'commandResponse'] as const) {
      const uuid = LIBRE3_CHAR[key];
      cleanups.push(await this.conn.subscribe(LIBRE3_SECURITY_SERVICE, uuid, (data) => this.mailbox.push(uuid, data)));
    }
    return () => cleanups.forEach((c) => c());
  }

  /** Writes a logical message in 18-byte fragments with a 2-byte offset prefix. */
  async write(channel: SecurityChannel, message: Bytes, label: string): Promise<void> {
    for (const fragment of fragmentForWrite(message)) {
      await withTimeout(this.conn.write(LIBRE3_SECURITY_SERVICE, LIBRE3_CHAR[channel], fragment, true), this.timeouts.writeMs, () => new WriteTimeoutError(label, this.timeouts.writeMs));
    }
  }

  async writeCommand(command: number, label: string): Promise<void> {
    await withTimeout(this.conn.write(LIBRE3_SECURITY_SERVICE, LIBRE3_CHAR.commandResponse, Uint8Array.of(command), true), this.timeouts.writeMs, () => new WriteTimeoutError(label, this.timeouts.writeMs));
  }

  awaitCommand(): Promise<Bytes> {
    return this.mailbox.next(LIBRE3_CHAR.commandResponse, this.timeouts.commandMs);
  }

  /** Reassembles notify fragments on `channel` until `n` bytes are available and returns the first `n`. */
  async awaitNotify(channel: SecurityChannel, n: number): Promise<Bytes> {
    const reassembler = new NotifyReassembler();
    while (reassembler.available < n) reassembler.feed(await this.mailbox.next(LIBRE3_CHAR[channel], this.timeouts.notifyMs));
    return reassembler.take(n);
  }
}
