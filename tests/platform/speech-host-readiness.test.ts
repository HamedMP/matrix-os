import { describe, expect, it, vi } from 'vitest';
import { isMachineSpeechReady } from '../../packages/platform/src/speech/host-readiness.js';

const machine = { handle: 'alice', machineId: 'machine_123', runtimeSlot: 'primary' };

describe('speech readiness response boundaries', () => {
  it.each([
    ['an oversized declared response', () => new Response('{}', { headers: { 'content-length': '17000' } })],
    ['an oversized streamed response', () => new Response('x'.repeat(17000))],
    ['malformed JSON', () => new Response('{')],
    ['an HTTP error', () => new Response('unavailable', { status: 503 })],
  ])('does not request capabilities after %s', async (_label, response) => {
    const get = vi.fn(async () => response());
    await expect(isMachineSpeechReady({ machine, get }).catch(() => false)).resolves.toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not accept an unauthorized capability response', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(Response.json({ runtime: machine }))
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await expect(isMachineSpeechReady({ machine, get })).resolves.toBe(false);
  });
});
