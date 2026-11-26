/**
 * Tiny listener set behind the optional `onHeartbeat` of CGM sources and pump drivers (see devices.ts).
 * Emitting never throws: a failing listener must not break the BLE callback that raised the heartbeat.
 */
export type HeartbeatListener = () => void;

export class HeartbeatEmitter {
  private listeners: readonly HeartbeatListener[] = [];

  /** Subscribes `listener`; returns the unsubscribe function. */
  on = (listener: HeartbeatListener): (() => void) => {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  };

  emit = (): void => {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a listener only requests a loop run; its failure is its own
      }
    }
  };

  get hasListeners(): boolean {
    return this.listeners.length > 0;
  }
}
