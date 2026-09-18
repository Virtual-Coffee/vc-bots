import { log } from "./log";

/**
 * In-memory work queue a Durable Object uses to serialize its own state-mutating handlers — the
 * runtime does not (its input gate only closes during storage ops, not across a `fetch`); ADR 0003.
 *
 * `run` chains `work` behind everything queued before it, so each item completes — outbound calls
 * included — before the next starts. The tail never rejects, so one failing item can't wedge the
 * queue; the failing caller still sees its own error. `logPrefix` names the owner in the queue
 * logs: `<prefix>.wait` at `info` fires only when an item lands behind in-flight work — the
 * interleaving the queue exists for; per-item `<prefix>.run` / `.done` (wait and run ms) are `debug`.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly logPrefix: string) {}

  /** Work items queued or running — readable via `runInDurableObject` so tests can prove interleaving. */
  get depth(): number {
    return this.pending;
  }

  /** Run `work` after every previously queued piece of work has finished. */
  run<T>(label: string, work: () => Promise<T>): Promise<T> {
    const depth = ++this.pending;
    const queuedAt = Date.now();
    if (depth > 1) log.info(`${this.logPrefix}.wait`, { work: label, depth });
    const run = this.tail.then(async () => {
      log.debug(`${this.logPrefix}.run`, { work: label, waitedMs: Date.now() - queuedAt });
      const startedAt = Date.now();
      try {
        return await work();
      } finally {
        this.pending--;
        log.debug(`${this.logPrefix}.done`, {
          work: label,
          ranMs: Date.now() - startedAt,
          depth: this.pending,
        });
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
