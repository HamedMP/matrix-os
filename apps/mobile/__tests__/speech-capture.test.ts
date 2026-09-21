jest.mock('@matrix-os/contracts', () => jest.requireActual('../../../packages/contracts/src/speech'));
import { createNativeSpeechCapture } from '../lib/speech/capture';

it('does not start after cancellation while permission is pending', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const stream = { start: jest.fn(), stop: jest.fn(), subscribe: jest.fn(() => ({ remove: jest.fn() })) };
  const adapter = createNativeSpeechCapture(stream, () => new Promise(resolve => { grant = resolve; }));
  const controller = new AbortController();
  const pending = adapter.start({ maxBytes: 1000, signal: controller.signal });
  controller.abort(); grant({ granted: true });
  await expect(pending).rejects.toThrow();
  expect(stream.start).not.toHaveBeenCalled();
});

it('starts capture when a pending first-use permission is granted', async () => {
  let grant!: (value: { granted: boolean }) => void;
  const stream = { start: jest.fn(async () => undefined), stop: jest.fn(), subscribe: jest.fn(() => ({ remove: jest.fn() })) };
  const adapter = createNativeSpeechCapture(stream, () => new Promise(resolve => { grant = resolve; }));
  const pending = adapter.start({ maxBytes: 1000, signal: new AbortController().signal });

  grant({ granted: true });
  const capture = await pending;

  expect(stream.start).toHaveBeenCalledTimes(1);
  await capture.cancel();
});

it('captures bounded PCM and removes listeners on stop', async () => {
  let deliver!: (buffer: { data: ArrayBuffer; sampleRate: number; channels: number; timestamp: number }) => void;
  const remove = jest.fn();
  const stream = { start: jest.fn(async () => undefined), stop: jest.fn(), subscribe: jest.fn(callback => { deliver = callback; return { remove }; }) };
  const adapter = createNativeSpeechCapture(stream, async () => ({ granted: true }));
  const onLevel = jest.fn();
  const capture = await adapter.start({ maxBytes: 100, signal: new AbortController().signal, onLevel });
  deliver({ data: new Int16Array([1000, -1000]).buffer, sampleRate: 16000, channels: 1, timestamp: 0 });
  const result = await capture.stop();
  expect(result.type).toBe('audio/wav'); expect(result.size).toBe(48);
  expect(onLevel).toHaveBeenCalled(); expect(remove).toHaveBeenCalledTimes(1);
  expect(stream.stop).toHaveBeenCalledTimes(1);
});

it('stops a stream that finishes startup after cancellation', async () => {
  let started!: () => void;
  const stream = { start: jest.fn(() => new Promise<void>(resolve => { started = resolve; })), stop: jest.fn(), subscribe: jest.fn(() => ({ remove: jest.fn() })) };
  const controller = new AbortController();
  const pending = createNativeSpeechCapture(stream, async () => ({ granted: true })).start({ maxBytes: 100, signal: controller.signal });
  await Promise.resolve(); controller.abort(); started();
  await expect(pending).rejects.toThrow(); expect(stream.stop).toHaveBeenCalledTimes(2);
});

it('handles a synchronous first buffer from the stream subscription', async () => {
  const remove = jest.fn();
  const stream = {
    start: jest.fn(async () => undefined),
    stop: jest.fn(),
    subscribe: jest.fn((callback) => {
      callback({ data: new Uint8Array(200).buffer, sampleRate: 16000, channels: 1, timestamp: 0 });
      return { remove };
    }),
  };
  const adapter = createNativeSpeechCapture(stream, async () => ({ granted: true }));
  const pending = adapter.start({ maxBytes: 100, signal: new AbortController().signal });

  await expect(pending).rejects.toThrow();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(stream.stop).toHaveBeenCalledTimes(1);
});

it('reports a terminal buffer failure immediately and clears the capture', async () => {
  let deliver!: (buffer: { data: ArrayBuffer; sampleRate: number; channels: number; timestamp: number }) => void;
  const remove = jest.fn();
  const stream = { start: jest.fn(async () => undefined), stop: jest.fn(), subscribe: jest.fn(callback => { deliver = callback; return { remove }; }) };
  const adapter = createNativeSpeechCapture(stream, async () => ({ granted: true }));
  const onError = jest.fn();
  const capture = await adapter.start({ maxBytes: 100, signal: new AbortController().signal, onError });

  deliver({ data: new Uint8Array(200).buffer, sampleRate: 16000, channels: 1, timestamp: 0 });

  expect(onError).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(stream.stop).toHaveBeenCalledTimes(1);
  await expect(capture.stop()).rejects.toThrow();
});

it('reports buffer failure even when native listener cleanup throws', async () => {
  let deliver!: (buffer: { data: ArrayBuffer; sampleRate: number; channels: number; timestamp: number }) => void;
  const stream = {
    start: jest.fn(async () => undefined),
    stop: jest.fn(() => { throw new Error('native stop failed'); }),
    subscribe: jest.fn(callback => { deliver = callback; return { remove: () => { throw new Error('listener remove failed'); } }; }),
  };
  const onError = jest.fn();
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const capture = await createNativeSpeechCapture(stream, async () => ({ granted: true }))
    .start({ maxBytes: 100, signal: new AbortController().signal, onError });

  expect(() => deliver({ data: new Uint8Array(200).buffer, sampleRate: 16000, channels: 1, timestamp: 0 })).not.toThrow();
  expect(onError).toHaveBeenCalledTimes(1);
  await expect(capture.stop()).rejects.toThrow('Recording unavailable');
  expect(warn).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});
