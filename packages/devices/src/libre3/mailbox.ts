/**
 * Small keyed notification mailbox with timeouts: fragments that arrive before anyone waits for
 * them are queued, waiters are served in order. Replaces `SensorSessionNotifyStore` from
 * RoundWhiteDiscKit `Pairing/SensorSessionTransport.swift` (MIT, (c) the RoundWhiteDiscKit authors).
 */
import type { Bytes } from '@buddy/core';

export class MailboxTimeoutError extends Error {
  constructor(readonly key: string, readonly ms: number) {
    super(`No notification on ${key.slice(0, 8)} within ${ms} ms`);
    this.name = 'MailboxTimeoutError';
  }
}

interface Waiter {
  resolve(data: Bytes): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class Mailbox {
  private readonly pending = new Map<string, Bytes[]>();
  private readonly waiters = new Map<string, Waiter[]>();
  private closed: Error | null = null;

  push(key: string, data: Bytes): void {
    const queue = this.waiters.get(key);
    const waiter = queue?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(data);
      return;
    }
    this.pending.set(key, [...(this.pending.get(key) ?? []), data]);
  }

  next(key: string, timeoutMs: number): Promise<Bytes> {
    const queued = this.pending.get(key);
    if (queued?.length) {
      const [head, ...rest] = queued;
      this.pending.set(key, rest);
      return Promise.resolve(head!);
    }
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<Bytes>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.set(key, (this.waiters.get(key) ?? []).filter((w) => w !== waiter));
          reject(new MailboxTimeoutError(key, timeoutMs));
        }, timeoutMs),
      };
      this.waiters.set(key, [...(this.waiters.get(key) ?? []), waiter]);
    });
  }

  /** Fails every waiter (link lost). Later `next` calls fail once the queue is empty. */
  close(error: Error): void {
    this.closed = error;
    for (const queue of this.waiters.values()) {
      for (const w of queue) {
        clearTimeout(w.timer);
        w.reject(error);
      }
    }
    this.waiters.clear();
  }
}
