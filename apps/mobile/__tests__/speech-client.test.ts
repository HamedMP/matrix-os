jest.mock('@matrix-os/contracts', () => jest.requireActual('../../../packages/contracts/src/speech'));
const mockFetch = jest.fn();
const mockDelete = jest.fn();
const mockWrite = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('expo-file-system', () => ({ Paths: { cache: 'cache' }, File: class extends Blob { constructor() { super([]); } exists = true; create() {} write = mockWrite; delete = mockDelete; } }));
import { createNativeSpeechClient } from '../lib/speech/client';

beforeEach(() => { jest.clearAllMocks(); });
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
