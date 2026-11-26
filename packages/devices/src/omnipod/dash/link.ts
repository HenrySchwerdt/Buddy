/**
 * DASH BLE link: RTS/CTS flow control on the command characteristic, fragmented payloads on the
 * data characteristic. Port of `Bluetooth/PeripheralManager+OmnipodKit.swift`
 * (`sendMessagePacket`, `readMessagePacket`, `waitForCommand`, `waitForData`, `sendHello`) from
 * OmnipodKit (MIT License, (c) LoopKit Authors), on top of Buddy's `BleConnection`.
 *
 * `sendMessagePacket` distinguishes "nothing was sent" from "sent, but the acknowledgement is
 * missing": the driver relies on that to know whether a command may have reached the pod.
 */
import { concatBytes, type BleConnection, type Bytes, type Logger } from '@buddy/core';
import { be32 } from '../common/bytes';
import { PayloadJoiner, splitPayload } from './ble-packets';
import {
  DASH_COMMAND_CHARACTERISTIC,
  DASH_DATA_CHARACTERISTIC,
  DASH_SERVICE_UUID,
  PodCommand,
} from './constants';
import { errorMessage, OmnipodError } from './errors';
import { encodeMessagePacket, parseMessagePacket, type MessagePacket } from './message-packet';

export type SendResult =
  | { readonly kind: 'sentWithAcknowledgment' }
  | { readonly kind: 'sentWithError'; readonly error: unknown }
  | { readonly kind: 'unsentWithError'; readonly error: unknown };

export interface PodLinkOptions {
  /** per BLE operation (write, wait for CTS/SUCCESS, wait for a data packet) */
  readonly ioTimeoutMs: number;
  readonly log: Logger;
}

/** FIFO of notifications with awaitable, time-limited reads. */
class Mailbox {
  private items: Bytes[] = [];
  private waiter: { resolve: (b: Bytes) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: unknown = null;

  push(b: Bytes): void {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(b);
    } else {
      this.items.push(b);
    }
  }

  next(timeoutMs: number): Promise<Bytes> {
    const head = this.items.shift();
    if (head) return Promise.resolve(head);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Bytes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new OmnipodError('timeout', 'Timed out waiting for the pod'));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  some(pred: (b: Bytes) => boolean): boolean {
    return this.items.some(pred);
  }

  clear(): void {
    this.items = [];
  }

  fail(error: unknown): void {
    this.failure = error;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(error);
    }
  }
}

export class PodLink {
  private readonly commands = new Mailbox();
  private readonly data = new Mailbox();
  private readonly unsubscribe: (() => void)[] = [];
  private open = true;

  constructor(
    private readonly conn: BleConnection,
    private readonly opts: PodLinkOptions,
  ) {
    this.unsubscribe.push(
      conn.onDisconnect((err) => {
        this.markClosed(err);
      }),
    );
  }

  get isOpen(): boolean {
    return this.open;
  }

  get deviceId(): string {
    return this.conn.deviceId;
  }

  private markClosed(err: Error | null): void {
    if (!this.open) return;
    this.open = false;
    const e = new OmnipodError('notConnected', err ? `Pod disconnected: ${err.message}` : 'Pod disconnected');
    this.commands.fail(e);
    this.data.fail(e);
  }

  /** Drops the connection (also used when the pod stops answering). */
  async close(): Promise<void> {
    this.markClosed(null);
    for (const u of this.unsubscribe.splice(0)) u();
    await this.conn.disconnect().catch(() => undefined);
  }

  // ── primitives ──────────────────────────────────────────────────────────────

  private async write(characteristic: string, value: Bytes): Promise<void> {
    if (!this.open) throw new OmnipodError('notConnected', 'Pod not connected');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.conn.write(DASH_SERVICE_UUID, characteristic, value, true),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new OmnipodError('timeout', 'BLE write timed out')), this.opts.ioTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sendCommandType(command: PodCommand): Promise<void> {
    return this.write(DASH_COMMAND_CHARACTERISTIC, new Uint8Array([command]));
  }

  private async waitForCommand(command: PodCommand): Promise<void> {
    for (;;) {
      const value = await this.commands.next(this.opts.ioTimeoutMs);
      if (value[0] === command) return;
      if (value[0] === PodCommand.NACK) throw new OmnipodError('nack', 'Pod sent NACK');
      throw new OmnipodError('protocol', `Unexpected pod command 0x${(value[0] ?? 0).toString(16)}, wanted 0x${command.toString(16)}`);
    }
  }

  private async waitForData(sequence: number): Promise<Bytes> {
    const value = await this.data.next(this.opts.ioTimeoutMs);
    if (value[0] !== sequence) throw new OmnipodError('protocol', `Unexpected data packet ${value[0]}, wanted ${sequence}`);
    return value;
  }

  // ── connection setup ────────────────────────────────────────────────────────

  /**
   * HELLO with the controller id, then enable notifications. The order matters: the pod drops
   * the link if notifications are enabled before the hello.
   */
  async hello(controllerId: number): Promise<void> {
    await this.write(DASH_COMMAND_CHARACTERISTIC, concatBytes(new Uint8Array([PodCommand.HELLO, 0x01, 0x04]), be32(controllerId)));
    this.unsubscribe.push(await this.conn.subscribe(DASH_SERVICE_UUID, DASH_COMMAND_CHARACTERISTIC, (b) => this.commands.push(b)));
    this.unsubscribe.push(await this.conn.subscribe(DASH_SERVICE_UUID, DASH_DATA_CHARACTERISTIC, (b) => this.data.push(b)));
  }

  // ── message packets ─────────────────────────────────────────────────────────

  async sendMessagePacket(message: MessagePacket, forEncryption = false): Promise<SendResult> {
    let didSend = false;
    try {
      this.commands.clear();
      this.data.clear();
      await this.sendCommandType(PodCommand.RTS);
      await this.waitForCommand(PodCommand.CTS);
      const packets = splitPayload(encodeMessagePacket(message, forEncryption));
      for (let i = 0; i < packets.length; i++) {
        if (i === packets.length - 1) didSend = true;
        await this.write(DASH_DATA_CHARACTERISTIC, packets[i]!);
        if (this.commands.some((c) => c[0] === PodCommand.NACK)) throw new OmnipodError('nack', 'Pod sent NACK');
      }
      await this.waitForCommand(PodCommand.SUCCESS);
      return { kind: 'sentWithAcknowledgment' };
    } catch (error) {
      this.opts.log.warn(`Omnipod link: send failed (${didSend ? 'after' : 'before'} the last packet): ${errorMessage(error)}`);
      return didSend ? { kind: 'sentWithError', error } : { kind: 'unsentWithError', error };
    }
  }

  async readMessagePacket(): Promise<MessagePacket> {
    try {
      await this.waitForCommand(PodCommand.RTS);
      await this.sendCommandType(PodCommand.CTS);
      let expected = 0;
      const joiner = new PayloadJoiner(await this.waitForData(expected));
      for (let i = 0; i < joiner.fullFragments; i++) {
        expected += 1;
        joiner.accumulate(await this.waitForData(expected));
      }
      if (joiner.oneExtraPacket) {
        expected += 1;
        joiner.accumulate(await this.waitForData(expected));
      }
      const payload = joiner.finalize();
      await this.sendCommandType(PodCommand.SUCCESS);
      return parseMessagePacket(payload);
    } catch (error) {
      if (error instanceof OmnipodError && (error.kind === 'timeout' || error.kind === 'notConnected')) {
        // an unresponsive pod: drop the link so the next attempt starts clean
        await this.close();
      } else if (this.open) {
        await this.sendCommandType(PodCommand.NACK).catch(() => undefined);
      }
      throw error instanceof OmnipodError ? error : new OmnipodError('protocol', errorMessage(error));
    }
  }
}
