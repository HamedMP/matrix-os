import { describe, expect, it, vi } from 'vitest';
import { createManagedServiceHealth } from '../../packages/gateway/src/managed-service-health';
describe('managed host health evidence', () => {
  it('checks fixed services with bounded execution and deduplicates polling', async () => {
    const run = vi.fn(async () => ({ stdout: 'active\nactive\n' }));
    const health = createManagedServiceHealth({ run });
    const [first, second] = await Promise.all([health(), health()]);
    expect(first).toEqual({ shell: true, syncAgent: true }); expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/usr/bin/systemctl', ['is-active', 'matrix-shell.service', 'matrix-sync-agent.service'], expect.objectContaining({ timeout: 5000, maxBuffer: 4096 }));
    await health(); expect(run).toHaveBeenCalledTimes(1);
  });
  it('fails closed with coarse health on missing systemd or inactive services', async () => {
    const run = vi.fn().mockRejectedValue(new Error('systemd unavailable'));
    expect(await createManagedServiceHealth({ run })()).toEqual({ shell: false, syncAgent: false });
  });
});
