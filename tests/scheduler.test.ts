import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bounded, CoalescingScheduler } from '../server/async';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
describe('bounded coalescing scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('allows one in flight and keeps only the latest pending snapshot', async () => {
    const first = deferred<string>();
    const work = vi.fn<(v: string, s: AbortSignal) => Promise<string>>().mockImplementationOnce(() => first.promise).mockImplementation(async v => v);
    const done = vi.fn();
    const scheduler = new CoalescingScheduler(work, done, vi.fn(), 200, 4000, () => Date.now());
    scheduler.offer('first');
    await vi.advanceTimersByTimeAsync(0);
    scheduler.offer('second');
    scheduler.offer('third');
    await vi.advanceTimersByTimeAsync(300);
    expect(work).toHaveBeenCalledTimes(1);
    first.resolve('first');
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.idle();
    expect(work.mock.calls.map(c => c[0])).toEqual(['first', 'third']);
    expect(done).toHaveBeenCalledTimes(2);
  });
  it('flushes a final snapshot without another interval and does not poll idle text', async () => {
    const work = vi.fn(async (v: string) => v);
    const scheduler = new CoalescingScheduler(work, vi.fn(), vi.fn(), 200, 4000, () => Date.now());
    scheduler.offer('a');
    await vi.advanceTimersByTimeAsync(0);
    scheduler.offer('final', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).toHaveBeenCalledTimes(2);
  });
  it('invalidates stale results, aborts old requests and drains before starting the next', async () => {
    const old = deferred<string>();
    const work = vi.fn<(v: string, s: AbortSignal) => Promise<string>>().mockImplementationOnce(() => old.promise).mockImplementation(async v => v);
    const done = vi.fn();
    const scheduler = new CoalescingScheduler(work, done, vi.fn(), 200, 4000, () => Date.now());
    scheduler.offer('old');
    await vi.advanceTimersByTimeAsync(0);
    scheduler.reset();
    expect(work.mock.calls[0][1].aborted).toBe(true);
    scheduler.offer('new', true);
    await vi.advanceTimersByTimeAsync(0);
    old.resolve('stale');
    await vi.advanceTimersByTimeAsync(0);
    expect(done.mock.calls).toEqual([['new', 'new']]);
  });
  it('fails explicitly at the timeout instead of silently passing', async () => {
    const fail = vi.fn();
    const done = vi.fn();
    const scheduler = new CoalescingScheduler(() => new Promise<never>(() => {}), done, fail, 200, 400, () => Date.now());
    scheduler.offer('blocked');
    await vi.advanceTimersByTimeAsync(401);
    expect(fail).toHaveBeenCalledOnce();
    expect(fail.mock.calls[0][1].code).toBe('timeout');
    expect(done).not.toHaveBeenCalled();
    await scheduler.idle();
  });
  it('honors a parent abort before starting work', async () => {
    const parent = new AbortController(); parent.abort();
    const work = vi.fn(async () => true);
    await expect(bounded(work, 1000, parent.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(work).not.toHaveBeenCalled();
  });
  it('paces nonfinal requests by 200ms', async () => {
    const work = vi.fn(async (v: number) => v);
    const scheduler = new CoalescingScheduler(work, vi.fn(), vi.fn(), 200, 4000, () => Date.now());
    scheduler.offer(1);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.offer(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
  });
});
