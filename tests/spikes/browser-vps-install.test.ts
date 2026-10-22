import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { AppManifestSchema } from '../../packages/gateway/src/app-runtime/manifest-schema.js';
import { computeDistributionStatus } from '../../packages/gateway/src/app-runtime/distribution-policy.js';

describe('test VPS browser app installation', () => {
  it('opens the prebuilt React app without rebuilding or an unavailable trust tier', async () => {
    const raw = JSON.parse(await readFile('scripts/spikes/browser-vps/lab/matrix.json', 'utf8'));
    const manifest = AppManifestSchema.parse(raw);
    expect(manifest.runtime).toBe('static');
    expect(computeDistributionStatus(manifest.listingTrust, { sandboxEnforced: false, allowCommunityInstalls: false })).toBe('installable');
  });
});
