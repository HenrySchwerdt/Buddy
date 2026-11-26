/**
 * Message pipe over one GATT connection to the bridge (the fragmentation / MTU part of
 * InsightKit `BLEBridgeLink`): subscribes to `tx`, reassembles section 2 fragments into
 * envelopes and writes outgoing envelopes to `rx` fragment by fragment (with response, in order).
 */
import type { BleConnection, Bytes, Clock, Logger } from '@buddy/core';
import { BRIDGE_RX_UUID, BRIDGE_SERVICE_UUID, BRIDGE_TX_UUID, MAX_MESSAGE_SIZE } from './constants';
import { fragmentMessage, Reassembler } from './fragmentation';

/** ATT payload per write at the minimum MTU (23 - 3). */
const MIN_FRAGMENT = 20;
/** Never ask the stack for more than this per write (some stacks mis-report the MTU). */
const MAX_FRAGMENT = 244;

export interface BridgeChannel {
  readonly peripheralId: string;
  /** Sends one envelope; rejects when not all fragments could be written. */
  send(envelope: Bytes): Promise<void>;
  /** The handler gets every complete envelope; envelopes that arrive earlier are buffered. */
  setHandler(handler: (envelope: Bytes) => void): void;
  onClose(listener: (error: Error | null) => void): void;
  readonly isOpen: boolean;
  close(): Promise<void>;
}

export async function openBleChannel(conn: BleConnection, clock: Clock, log: Logger): Promise<BridgeChannel> {
  let open = true;
  let handler: ((e: Bytes) => void) | null = null;
  const buffer: Bytes[] = [];
  const closeListeners = new Set<(e: Error | null) => void>();
  const reassembler = new Reassembler();
  let seq = 0;
  let writing: Promise<unknown> = Promise.resolve();

  const finish = (error: Error | null) => {
    if (!open) return;
    open = false;
    unsubscribeDisconnect();
    unsubscribe?.();
    for (const l of closeListeners) l(error);
  };

  const unsubscribeDisconnect = conn.onDisconnect((e) => finish(e ?? new Error('Bridge disconnected')));
  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = await conn.subscribe(BRIDGE_SERVICE_UUID, BRIDGE_TX_UUID, (data) => {
      const outcome = reassembler.accept(data, clock.now());
      if (outcome.kind === 'complete') {
        if (handler) handler(outcome.message);
        else buffer.push(outcome.message);
      } else if (outcome.kind === 'dropped') log.info('Insight: dropped a fragment');
      else if (outcome.kind === 'tooLarge') log.warn(`Insight: dropped a message above ${MAX_MESSAGE_SIZE} bytes`);
    });
  } catch (e) {
    unsubscribeDisconnect();
    await conn.disconnect().catch(() => undefined);
    throw e;
  }
  if (!open) unsubscribe();

  return {
    peripheralId: conn.deviceId,
    get isOpen() {
      return open;
    },
    send(envelope) {
      // Writes are strictly sequential: fragments of different messages must never interleave.
      const run = async () => {
        if (!open) throw new Error('Bridge channel is closed');
        const size = Math.min(MAX_FRAGMENT, Math.max(MIN_FRAGMENT, conn.mtu - 3));
        seq = (seq + 1) & 0xffff;
        const fragments = fragmentMessage(envelope, seq, size);
        if (!fragments) throw new Error('Insight: message cannot be fragmented');
        for (const f of fragments) {
          if (!open) throw new Error('Bridge channel closed while sending');
          await conn.write(BRIDGE_SERVICE_UUID, BRIDGE_RX_UUID, f, true);
        }
      };
      const next = writing.then(run, run);
      writing = next.catch(() => undefined);
      return next;
    },
    setHandler(h) {
      handler = h;
      for (const e of buffer.splice(0)) h(e);
    },
    onClose(l) {
      if (!open) l(null);
      else closeListeners.add(l);
    },
    async close() {
      const wasOpen = open;
      finish(null);
      if (wasOpen) await conn.disconnect().catch(() => undefined);
    },
  };
}
