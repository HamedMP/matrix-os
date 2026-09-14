jest.mock('@matrix-os/contracts', () => jest.requireActual('../../../packages/contracts/src/speech'));
const mockFetch = jest.fn();
const mockDelete = jest.fn();
const mockWrite = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('expo-file-system', () => ({ Paths: { cache: 'cache' }, File: class extends Blob { constructor() { super([], { type: 'audio/wav' }); } exists = true; create() {} write = mockWrite; delete = mockDelete; } }));
import { createNativeSpeechClient } from '../lib/speech/client';

beforeEach(() => { mockFetch.mockReset(); mockDelete.mockReset(); mockWrite.mockReset(); });
it('does not dispatch after cancellation during token lookup', async () => {
  let resolve!: (token: string) => void;
  const client = createNativeSpeechClient({ baseUrl: 'https://example.com/vm/alice', runtimeSlot: 'primary', getToken: () => new Promise(r => { resolve = r; }) });
  const controller = new AbortController();
  const pending = client.capabilities(controller.signal);
  controller.abort(); resolve('token');
  await expect(pending).rejects.toThrow('Speech is unavailable');
  expect(mockFetch).not.toHaveBeenCalled();
});
it('deletes local recording and clears bytes after upload failure', async () => {
  mockFetch.mockRejectedValue(new Error('secret provider details'));
  const client = createNativeSpeechClient({ baseUrl: 'https://example.com/vm/alice', runtimeSlot: 'preview', getToken: async () => 'token' });
  const bytes = new Uint8Array([1, 2, 3]);
  await expect(client.transcribe({ recording: { bytes, type: 'audio/wav', size: 3 }, requestId: 'sp_1789000000000_abcdefghijklmnop', signal: new AbortController().signal })).rejects.toThrow('Speech is unavailable');
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect([...bytes]).toEqual([0, 0, 0]);
});

it('preserves a successful transcript when cache cleanup fails', async () => {
  jest.useFakeTimers();
  const requestId = 'sp_1789000000000_abcdefghijklmnop';
  const response = {
    contractVersion: 1,
    requestId,
    status: 'succeeded',
    outcome: 'transcript',
    text: 'hello from mobile',
    audioDurationMs: 1000,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  mockFetch.mockResolvedValue({
    ok: true,
    body: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }),
  });
  mockDelete.mockImplementationOnce(() => { throw new Error('cache cleanup failed'); });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const client = createNativeSpeechClient({ baseUrl: 'https://example.com/vm/alice', runtimeSlot: 'preview', getToken: async () => 'token' });
  const bytes = new Uint8Array([1, 2, 3]);

  await expect(client.transcribe({ recording: { bytes, type: 'audio/wav', size: 3 }, requestId, signal: new AbortController().signal })).resolves.toEqual(response);
  expect([...bytes]).toEqual([0, 0, 0]);
  expect(warn).toHaveBeenCalledWith('Native speech cache cleanup failed', 'Error');
  jest.runAllTimers();
  expect(mockDelete).toHaveBeenCalledTimes(2);
  warn.mockRestore();
  jest.useRealTimers();
});

it('sends the Expo file as authenticated WAV multipart to the selected runtime', async () => {
  const requestId = 'sp_1789000000000_abcdefghijklmnop';
  const response = { contractVersion: 1, requestId, status: 'succeeded', outcome: 'transcript', text: 'hello', audioDurationMs: 1000 };
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  mockFetch.mockResolvedValue({ ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }) });
  const client = createNativeSpeechClient({ baseUrl: 'https://example.com/vm/alice', runtimeSlot: 'preview', getToken: async () => 'clerk-token' });

  await expect(client.transcribe({ recording: { bytes: new Uint8Array([1, 2, 3]), type: 'audio/wav', size: 3 }, requestId, signal: new AbortController().signal })).resolves.toEqual(response);

  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('https://example.com/vm/alice/api/speech/transcriptions?runtime=preview');
  expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer clerk-token', accept: 'application/json' }, redirect: 'error' });
  const recording = init.body.get('recording');
  expect(init.body.get('requestId')).toBe(requestId);
  expect(recording).toMatchObject({ name: 'recording.wav', type: 'audio/wav' });
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

it('aborts an in-flight Expo upload and still removes the cache file', async () => {
  mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const client = createNativeSpeechClient({ baseUrl: 'https://example.com/vm/alice', runtimeSlot: 'preview', getToken: async () => 'token' });
  const controller = new AbortController();
  const pending = client.transcribe({ recording: { bytes: new Uint8Array([1, 2, 3]), type: 'audio/wav', size: 3 }, requestId: 'sp_1789000000000_abcdefghijklmnop', signal: controller.signal });
  await Promise.resolve();
  controller.abort();

  await expect(pending).rejects.toThrow('Speech is unavailable');
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
