/**
 * TypeScript port of the command/response plumbing of `PeripheralManager+RileyLink.swift`
 * (`writeCommand`, `writeLegacyCommand`, the responseCount -> read(data) macro) from RileyLinkBLEKit
 * (RileyLinkKit, MIT License, (c) Pete Schwamb).
 *
 * One command is in flight at a time. A command frame is `[length, ...command]` written to the data
 * characteristic; the RileyLink bumps the responseCount characteristic (notify) when a response is ready
 * and the response is then read from the data characteristic.
 */
import { hex, type BleConnection, type Bytes, type Logger } from '@buddy/core';
import { errorMessage, RileyLinkError } from './errors';
import { isResponseCode, MAX_COMMAND_LENGTH, ResponseCode, RILEYLINK_SERVICE_UUID, RL_CHAR } from './constants';
import { legacyResponses, type ResponseParser, type RlResponse } from './responses';
import type { ResponseFraming } from './firmware';

interface InFlight {
  /** Feed a value read from the data characteristic; returns true when the command is complete. */
  readonly onValue: (value: Bytes) => void;
  readonly abort: (e: RileyLinkError) => void;
}

export class CommandChannel {
  private current: InFlight | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private reads: Promise<unknown> = Promise.resolve();
  private closedError: RileyLinkError | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeDisconnect: (() => void) | null = null;
  framing: ResponseFraming = 'buffered';

  private constructor(
    private readonly conn: BleConnection,
    private readonly log: Logger,
  ) {}

  /** Subscribes to responseCount notifications and starts listening for disconnects. */
  static async open(conn: BleConnection, log: Logger): Promise<CommandChannel> {
    const ch = new CommandChannel(conn, log);
    ch.unsubscribeDisconnect = conn.onDisconnect((err) => ch.close(new RileyLinkError('disconnected', err ? `RileyLink disconnected: ${err.message}` : 'RileyLink disconnected')));
    ch.unsubscribe = await conn.subscribe(RILEYLINK_SERVICE_UUID, RL_CHAR.responseCount, () => ch.onResponseCount());
    return ch;
  }

  get isOpen(): boolean {
    return this.closedError === null;
  }

  close(reason: RileyLinkError = new RileyLinkError('disconnected', 'RileyLink connection closed')): void {
    if (this.closedError) return;
    this.closedError = reason;
    this.unsubscribe?.();
    this.unsubscribeDisconnect?.();
    this.current?.abort(reason);
  }

  /**
   * Sends a command and resolves with the first matching response. `timeoutMs` is the full budget
   * (callers add BLE latency). Calls are serialised.
   *
   * @throws RileyLinkError `commandsBlocked` when the write succeeded but no response came;
   *         `bleError` when the write itself did not complete; `disconnected`; `writeSizeLimitExceeded`.
   */
  execute<R extends RlResponse>(command: Bytes, parser: ResponseParser<R>, timeoutMs: number): Promise<R> {
    if (command.length > MAX_COMMAND_LENGTH) {
      return Promise.reject(new RileyLinkError('writeSizeLimitExceeded', `Data exceeded maximum size of ${MAX_COMMAND_LENGTH} bytes`));
    }
    const run = () => this.run(command, parser, timeoutMs);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private run<R extends RlResponse>(command: Bytes, parser: ResponseParser<R>, timeoutMs: number): Promise<R> {
    if (this.closedError) return Promise.reject(this.closedError);
    const frame = new Uint8Array(command.length + 1);
    frame[0] = command.length;
    frame.set(command, 1);
    const framing = this.framing;
    this.log.info(`RL send (${framing}): ${frame.length} bytes, command 0x${(command[0] ?? 0).toString(16).padStart(2, '0')}`);

    return new Promise<R>((resolve, reject) => {
      let writeDone = false;
      let buffer: Bytes = new Uint8Array(0);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.current === inFlight) this.current = null;
        fn();
      };
      const timer = setTimeout(
        () =>
          settle(() =>
            reject(
              writeDone
                ? new RileyLinkError('commandsBlocked', 'RileyLink command did not respond')
                : new RileyLinkError('bleError', 'Timed out writing to the RileyLink'),
            ),
          ),
        timeoutMs,
      );

      const inFlight: InFlight = {
        abort: (e) => settle(() => reject(e)),
        onValue: (value) => {
          if (settled) return;
          if (framing === 'single') {
            const r = this.matchSingle(value, parser);
            if (r) settle(() => resolve(r));
            return;
          }
          buffer = concat(buffer, value);
          const r = this.matchBuffered(buffer, parser);
          if (r) settle(() => resolve(r));
        },
      };
      this.current = inFlight;

      this.conn.write(RILEYLINK_SERVICE_UUID, RL_CHAR.data, frame, true).then(
        () => {
          writeDone = true;
        },
        (e) => settle(() => reject(new RileyLinkError('bleError', `RileyLink write failed: ${errorMessage(e)}`))),
      );
    });
  }

  private matchSingle<R extends RlResponse>(value: Bytes, parser: ResponseParser<R>): R | null {
    if (value.length === 0) return null; // empty: keep listening
    const first = value[0]!;
    if (!isResponseCode(first)) {
      this.log.error(`Unknown response code from RileyLink: ${hex(value.subarray(0, 1))}. Continuing to listen.`);
      return null;
    }
    // Expected when an idle GetPacket was running and got preempted by this command.
    if (first === ResponseCode.commandInterrupted) return null;
    const r = parser.parse(value);
    if (!r) this.log.error(`Unable to parse RileyLink response (${value.length} bytes, code 0x${first.toString(16).padStart(2, '0')})`);
    return r;
  }

  private matchBuffered<R extends RlResponse>(buffer: Bytes, parser: ResponseParser<R>): R | null {
    for (const r of legacyResponses(parser, buffer)) {
      if (r.code !== ResponseCode.commandInterrupted) return r;
    }
    return null;
  }

  private onResponseCount(): void {
    // Reads are chained so concurrent notifications cannot reorder responses.
    this.reads = this.reads.then(async () => {
      if (this.closedError) return;
      try {
        const value = await this.conn.read(RILEYLINK_SERVICE_UUID, RL_CHAR.data);
        this.log.info(`RL recv: ${value.length} bytes, code 0x${(value[0] ?? 0).toString(16).padStart(2, '0')}`);
        if (this.current) this.current.onValue(value);
        else this.log.info('RL: unsolicited response (no command in flight) dropped');
      } catch (e) {
        const err = new RileyLinkError('bleError', `RileyLink read failed: ${errorMessage(e)}`);
        if (this.current) this.current.abort(err);
        else this.log.warn(err.message);
      }
    });
  }
}

const concat = (a: Bytes, b: Bytes): Bytes => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};
