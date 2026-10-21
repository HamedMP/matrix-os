import { afterEach, expect, it, vi } from 'vitest';
import { observeNativeCommandCompletion } from '../../packages/gateway/src/ai-providers/native-command-completion.js';
afterEach(() => vi.useRealTimers());
it.each([0, 1, 130])('preserves explicit exit %s and settles once without overlapping observations', async exitCode => {
  vi.useFakeTimers();
  let release!: (value: unknown) => void;
  const read = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const onExited = vi.fn(async () => {});
  const observer = observeNativeCommandCompletion({ read, onExited, active: () => true });
  const first = observer.check(); const duplicate = observer.check();
  expect(read).toHaveBeenCalledOnce();
  release({ state: 'exited', exitCode }); await Promise.all([first, duplicate]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(onExited).toHaveBeenCalledExactlyOnceWith(exitCode);
  expect(read).toHaveBeenCalledOnce(); observer.stop();
});
it.each([{ state: 'exited' }, 'exited', { state: 'unknown' }, { state: 'running' }, { state: 'exited', exitCode: null }, { state: 'exited', exitCode: -1 }])('does not invent a successful exit from %j', async result => {
  vi.useFakeTimers();
  const read = vi.fn(async () => result), onExited = vi.fn();
  const observer = observeNativeCommandCompletion({ read, onExited, active: () => true });
  await observer.check(); await vi.advanceTimersByTimeAsync(2000);
  expect(onExited).not.toHaveBeenCalled(); observer.stop();
});
it.each(['stop', 'inactive'] as const)('discards an in-flight success after %s', async mode => {
  vi.useFakeTimers(); let active = true; let release!: (value: unknown) => void;
  const onExited = vi.fn(); const read = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const observer = observeNativeCommandCompletion({ read, onExited, active: () => active });
  const pending = observer.check(); if (mode === 'stop') observer.stop(); else active = false;
  release({ state: 'exited', exitCode: 0 }); await pending; await vi.advanceTimersByTimeAsync(5000);
  expect(onExited).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce(); observer.stop();
});
it('bounds retries to one local observation at a time after an unavailable read', async () => {
  vi.useFakeTimers(); const onExited = vi.fn();
  const read = vi.fn().mockRejectedValueOnce(new Error('synthetic')).mockResolvedValue({ state: 'exited', exitCode: 0 });
  const observer = observeNativeCommandCompletion({ read, onExited, active: () => true });
  await observer.check(); expect(onExited).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000); expect(onExited).toHaveBeenCalledExactlyOnceWith(0); observer.stop();
});
