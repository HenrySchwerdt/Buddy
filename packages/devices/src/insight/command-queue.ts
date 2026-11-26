/**
 * Serial command queue (InsightKit `CommandQueue`): exactly one command sequence is in flight at
 * any time. Safety commands (cancel bolus, cancel temp basal, suspend) go before everything that
 * is still waiting, so a long refresh never delays them; they never overtake the running one.
 */
export class CommandQueue {
  private readonly waiting: { run: () => void; safety: boolean }[] = [];
  private running = false;

  get hasSafetyWaiting(): boolean {
    return this.waiting.some((w) => w.safety);
  }

  enqueue<T>(work: () => Promise<T>, safety = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running = true;
        work().then(resolve, reject).finally(() => {
          this.running = false;
          this.next();
        });
      };
      if (!this.running && this.waiting.length === 0) run();
      else if (safety) {
        const firstNormal = this.waiting.findIndex((w) => !w.safety);
        this.waiting.splice(firstNormal === -1 ? this.waiting.length : firstNormal, 0, { run, safety });
      } else this.waiting.push({ run, safety });
    });
  }

  private next(): void {
    const item = this.waiting.shift();
    if (item) item.run();
  }
}
