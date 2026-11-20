/**
 * When callbacks are sent. The real scheduler uses setTimeout; tests use the
 * manual scheduler to move virtual time and await deliveries without sleeping.
 */
export interface Scheduler {
  schedule(task: () => Promise<void>, delayMs: number): void;
  /** Resolves once every task scheduled so far (and any it schedules) has finished. */
  settled(): Promise<void>;
}

export function createRealScheduler(): Scheduler {
  const pending = new Set<Promise<void>>();
  return {
    schedule(task, delayMs) {
      const p = new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          task()
            .catch(() => {})
            .finally(resolve);
        }, delayMs);
        t.unref?.();
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    },
    async settled() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

export interface ManualScheduler extends Scheduler {
  /** Current virtual time (ms since creation). */
  readonly now: number;
  /** Number of tasks not yet run. */
  pending(): number;
  /**
   * Advance virtual time by `ms`, running due tasks in (time, insertion) order
   * and awaiting each before the next. Returns the number of tasks run.
   */
  advance(ms: number): Promise<number>;
}

export function createManualScheduler(): ManualScheduler {
  let now = 0;
  let seq = 0;
  const queue: { at: number; seq: number; task: () => Promise<void> }[] = [];
  const next = () => queue.sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
  return {
    get now() {
      return now;
    },
    schedule(task, delayMs) {
      queue.push({ at: now + delayMs, seq: seq++, task });
    },
    pending: () => queue.length,
    async advance(ms) {
      const target = now + ms;
      let ran = 0;
      for (let item = next(); item && item.at <= target; item = next()) {
        queue.splice(queue.indexOf(item), 1);
        now = item.at;
        await item.task().catch(() => {});
        ran++;
      }
      now = target;
      return ran;
    },
    async settled() {
      // Manual time only moves via advance().
    },
  };
}
