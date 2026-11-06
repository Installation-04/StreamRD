export class CapacityError extends Error {
  constructor() { super("Server is busy; try again shortly"); }
}
/** Process-wide FIFO limits, including a bounded waiting queue. */
export class BoundedExecutor {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number, private maxQueued: number, private waitMs = 10000) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit && this.queue.length >= this.maxQueued) return Promise.reject(new CapacityError());
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = () => {
        clearTimeout(timer);
        this.active++;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          this.active--;
          this.queue.shift()?.();
        });
      };
      if (this.active < this.limit) start(); else {
        this.queue.push(start);
        timer = setTimeout(() => {
          const index = this.queue.indexOf(start);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new CapacityError());
        }, this.waitMs);
      }
    });
  }
}
