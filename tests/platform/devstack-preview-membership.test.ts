import { describe, expect, it, vi } from 'vitest';
import { createDevstackPreviewMembershipLookup } from '../../packages/platform/src/devstack-preview-membership.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';

const endpoint = 'https://app.matrix-os.com/api/private-previews';
const token = 'eyJverified.fixture.signature';
const actor = 'user_fixture';
const response = (status = 200) => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });

const config = {
  issuer: 'https://clerk.matrix-os.com',
  previewOrigin: 'https://devstack.matrix-os.com',
  operators: [actor],
  targets: [{ runtime: 'hel1', worktree: 'candidate', owner: actor, handle: 'hel1-stage3', containerId: 'b'.repeat(64) }],
};

describe('DevStack private-preview API membership check', () => {
  it('uses the fixed first-party endpoint with only a verified bearer and discards the response body', async () => {
    const result = response();
    const cancel = vi.spyOn(result.body!, 'cancel');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(result);
    const isMember = createDevstackPreviewMembershipLookup(fetchImpl);

    await expect(isMember(actor, token)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails closed on denial, errors, other success codes, or an unexpected success response', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const isMember = createDevstackPreviewMembershipLookup(fetchImpl);
    for (const status of [201, 302, 401, 403, 404, 503]) {
      fetchImpl.mockResolvedValueOnce(response(status));
      await expect(isMember(actor, token)).resolves.toBe(false);
    }
    fetchImpl.mockResolvedValueOnce(new Response('unexpected', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(isMember(actor, token)).resolves.toBe(false);
    fetchImpl.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(isMember(actor, token)).resolves.toBe(false);
  });

  it('coalesces only the same bearer while pending and asks upstream again after completion', async () => {
    let complete!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValueOnce(pending).mockResolvedValueOnce(response(403)).mockResolvedValueOnce(response(403));
    const isMember = createDevstackPreviewMembershipLookup(fetchImpl);
    const first = isMember(actor, token);
    const second = isMember(actor, token);
    await expect(isMember(actor, 'eyJdifferent.fixture.signature')).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    complete(response());
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(isMember(actor, token)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('accepts an explicit private-preview API membership source only with public browser mode', () => {
    expect(loadDevstackPreviewConfig(JSON.stringify(config), 'hel1')?.membershipSource).toBeUndefined();
    const apiConfig = { ...config, membershipSource: 'private-preview-api' };
    expect(() => loadDevstackPreviewConfig(JSON.stringify(apiConfig), 'hel1')).toThrow(/configuration is invalid/);
    expect(loadDevstackPreviewConfig(JSON.stringify({ ...apiConfig, publicBrowserOnly: true }), 'hel1')?.membershipSource).toBe('private-preview-api');
    expect(() => loadDevstackPreviewConfig(JSON.stringify({ ...apiConfig, publicBrowserOnly: true, membershipSource: 'https://other.invalid' }), 'hel1')).toThrow();
  });
});
