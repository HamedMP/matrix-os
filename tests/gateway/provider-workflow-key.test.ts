import { describe, it, expect, vi } from 'vitest';
import { createProviderKeyVerifier } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';
describe('key verification boundary', () => {
  it('does not save rejected secrets or follow redirects', async () => {
    const save = vi.fn(); const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const verify = createProviderKeyVerifier({ providerId: 'openai', save, fetchFn });
    await expect(verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-test-secret' })).rejects.toThrow('rejected');
    expect(save).not.toHaveBeenCalled(); expect(fetchFn.mock.calls[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('saves only after an accepted bounded probe', async () => {
    const save = vi.fn(async () => {});
    const verify = createProviderKeyVerifier({ providerId: 'openai', save, fetchFn: async () => new Response('{}') });
    await verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'sk-test-secret' });
    expect(save).toHaveBeenCalledWith('sk-test-secret');
  });
  it.each([401])('rejects an Anthropic key the provider refuses with %i', async status => {
    const save = vi.fn(); const fetchFn = vi.fn(async () => new Response('{}', { status }));
    const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn });
    await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' })).rejects.toMatchObject({ code: 'rejected' });
    expect(save).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/models');
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ headers: { 'x-api-key': 'sk-ant-api03-test', 'anthropic-version': '2023-06-01' } });
  });
  it('rejects an Anthropic JSON 403 as a key verdict', async () => {
    const save = vi.fn();
    const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn: async () => new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }) });
    await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' })).rejects.toMatchObject({ code: 'rejected' });
    expect(save).not.toHaveBeenCalled();
  });
  it.each([{ 'content-type': 'text/html' }, { 'content-type': 'application/json', 'cf-mitigated': 'challenge' }])('reports an edge-blocked 403 (%o) as unavailable, not a bad key', async headers => {
    const save = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn: async () => new Response('<html></html>', { status: 403, headers }) });
      await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' })).rejects.toMatchObject({ code: 'unavailable' });
      expect(save).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[provider-workflow] Key probe unavailable:', 'anthropic', 403);
    } finally { warn.mockRestore(); }
  });
  it('refuses a Claude subscription token without sending it to the provider', async () => {
    const save = vi.fn(); const fetchFn = vi.fn();
    const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn });
    await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: ' sk-ant-oat01-test' })).rejects.toMatchObject({ code: 'rejected' });
    expect(fetchFn).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('names a key outside any workspace without logging or returning the provider text', async () => {
    const save = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const body = { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.' } };
      const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn: async () => Response.json(body, { status: 400 }) });
      const failure = await verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' }).catch(error => error);
      expect(failure).toMatchObject({ code: 'key_workspace_required' });
      expect(String(failure?.message)).not.toContain('scoped');
      expect(save).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('scoped');
    } finally { warn.mockRestore(); }
  });
  it.each([
    ['another request error', Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected header value.' } }, { status: 400 })],
    ['a non-JSON body', new Response('workspace', { status: 400, headers: { 'content-type': 'text/plain' } })],
    ['an oversized body', new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`{"error":{"message":"${'x'.repeat(8192)} workspace"}}`)); controller.close(); } }), { status: 400, headers: { 'content-type': 'application/json' } })],
  ])('keeps an Anthropic 400 with %s as unavailable', async (_name, response) => {
    const save = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn: async () => response });
      await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' })).rejects.toMatchObject({ code: 'unavailable' });
      expect(save).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
  it.each([408, 429, 500, 502, 503, 529])('reports an Anthropic %i as unavailable, not a bad key', async status => {
    const save = vi.fn(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const verify = createProviderKeyVerifier({ providerId: 'anthropic', save, fetchFn: async () => new Response('{}', { status }) });
      await expect(verify({ harnessInstanceId: 'claude', providerId: 'anthropic', apiKey: 'sk-ant-api03-test' })).rejects.toMatchObject({ code: 'unavailable' });
      expect(save).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[provider-workflow] Key probe unavailable:', 'anthropic', status);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-ant-api03-test');
    } finally { warn.mockRestore(); }
  });
});

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexKeySaver } from '../../packages/gateway/src/ai-providers/provider-workflow-key.js';
it('isolates a failed native CLI saver and preserves the exact previous auth bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'key-save-')); const prefix = join(home, 'runtime');
  try {
    await mkdir(join(home, '.codex')); await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(home, '.codex/auth.json'), '{"old":"keep-exact"}\n');
    await writeFile(join(prefix, 'bin/codex'), '#!/bin/sh\ncat >/dev/null\nprintf "{}" > "$CODEX_HOME/auth.json"\nexit 1\n', { mode: 0o700 });
    await expect(createCodexKeySaver({ homePath: home, runtimePrefix: prefix })('sk-synthetic-fixture')).rejects.toThrow();
    expect(await readFile(join(home, '.codex/auth.json'), 'utf8')).toBe('{"old":"keep-exact"}\n');
    expect((await readdir(join(home, '.codex'))).filter(name => name.startsWith('.matrix-key-'))).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
