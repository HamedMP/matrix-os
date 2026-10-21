import { describe, expect, it, vi } from 'vitest';
import { connectServiceHandler, getConnectionAttemptHandler } from '../../packages/kernel/src/tools/integration-connections.js';
const attemptId = '123e4567-e89b-42d3-a456-426614174000';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const text = (result: Awaited<ReturnType<typeof connectServiceHandler>>) => result.content.map(item => item.text).join('');
describe('owner Gmail receipt tools', () => {
  it('returns an exact receipt instruction rather than promising automatic completion', async () => {
    const fetcher = vi.fn(async () => reply({ url: 'https://pipedream.com/connect', service: 'gmail', attemptId }));
    const output = text(await connectServiceHandler({ service: 'gmail', connectionMethod: 'pipedream' }, fetcher));
    expect(output).toContain(attemptId); expect(output).toContain('get_connection_attempt'); expect(output).not.toContain('appear automatically');
    expect(output).toContain('This chat cannot confirm this attempt');
    expect(output).toContain('start a new tracked connection from Connect Apps');
    expect(output).not.toContain('Otherwise confirm it in Connect Apps');
  });
  it('returns only coarse owner receipt metadata and bounds the request', async () => {
    const fetcher = vi.fn(async () => reply({ status: 'succeeded', accountId: attemptId, token: 'private' }));
    const result = await getConnectionAttemptHandler({ attempt_id: attemptId }, fetcher);
    expect(JSON.parse(text(result))).toEqual({ status: 'succeeded', accountId: attemptId });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/gmail/pipedream/attempts/' + attemptId), expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal), redirect: 'error' }));
  });
  it('does not substitute inventory when the receipt is unavailable or malformed', async () => {
    const fetcher = vi.fn(async () => reply({ error: 'private' }, 404));
    expect((await getConnectionAttemptHandler({ attempt_id: attemptId }, fetcher)).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await getConnectionAttemptHandler({ attempt_id: 'bad' }, fetcher)).isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
