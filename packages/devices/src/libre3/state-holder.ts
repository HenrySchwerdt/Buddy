/**
 * Holds the current persisted sensor state and writes every change through to the secret store in
 * order (replaces the `setState` / rawState persistence of LibreLoop `LibreLoopCGMManager`,
 * MIT, (c) the LibreLoop authors).
 */
import type { Logger, SecretStore } from '@buddy/core';
import { saveSensorState, type Libre3SensorState } from './storage';

export class SensorStateHolder {
  private state: Libre3SensorState;
  private chain: Promise<void> = Promise.resolve();

  constructor(initial: Libre3SensorState, private readonly secrets: SecretStore, private readonly log: Logger) {
    this.state = initial;
  }

  get current(): Libre3SensorState {
    return this.state;
  }

  /** Applies a partial update immediately and queues the write. */
  update(patch: Partial<Libre3SensorState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.state;
    this.chain = this.chain
      .then(() => saveSensorState(this.secrets, snapshot))
      .catch((e: unknown) => this.log.error(`Libre 3: could not persist sensor state: ${(e as Error).message}`));
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
