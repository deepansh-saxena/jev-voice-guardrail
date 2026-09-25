export class GuardrailError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        abortListener = () => {
          controller.abort();
          reject(new GuardrailError('aborted', 'Guardrail request superseded or stopped.'));
        };
        parent?.addEventListener('abort', abortListener, { once: true });
        if (parent?.aborted) abortListener();
        timer = setTimeout(() => {
          controller.abort();
          reject(new GuardrailError('timeout', `Guardrail unavailable: timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new GuardrailError('aborted', 'Request aborted.');
        return work(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abortListener) parent?.removeEventListener('abort', abortListener);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof GuardrailError ? error.message : 'Guardrail unavailable: internal or transport error. See local error code.';
}

// One request in flight, one replaceable pending snapshot. Reset invalidates callbacks,
// but does not start another request until the aborted request has settled.
export class CoalescingScheduler<T, R> {
  private pending?: { value: T; final: boolean; epoch: number };
  private running = false;
  private epoch = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private lastStart = -Infinity;
  private waiters: (() => void)[] = [];
  constructor(
    private work: (value: T, signal: AbortSignal) => Promise<R>,
    private done: (value: T, result: R) => void,
    private fail: (value: T, error: unknown) => void,
    private intervalMs: number,
    private timeoutMs: number,
    private now = () => performance.now(),
  ) {}
  offer(value: T, final = false) {
    this.pending = { value, final, epoch: this.epoch };
    this.pump();
  }
  reset() {
    this.epoch++;
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.notify();
  }
  idle(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private notify() {
    if (!this.running && !this.pending) this.waiters.splice(0).forEach(resolve => resolve());
  }
  private pump() {
    if (this.running || !this.pending) { this.notify(); return; }
    clearTimeout(this.timer);
    const delay = this.pending.final ? 0 : Math.max(0, this.lastStart + this.intervalMs - this.now());
    if (delay > 0) { this.timer = setTimeout(() => this.pump(), delay); return; }
    const job = this.pending;
    this.pending = undefined;
    this.running = true;
    this.lastStart = this.now();
    this.abort = new AbortController();
    void bounded(signal => this.work(job.value, signal), this.timeoutMs, this.abort.signal)
      .then(result => { if (job.epoch === this.epoch) this.done(job.value, result); })
      .catch(error => { if (job.epoch === this.epoch) this.fail(job.value, error); })
      .finally(() => { this.running = false; this.abort = undefined; this.pump(); });
  }
}
