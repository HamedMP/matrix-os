import { describe, expect, it } from 'vitest';
import {
  loadCustomerVpsCloudInitTemplate,
  renderCloudInitTemplate,
} from '../../packages/platform/src/customer-vps-cloud-init.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from '../../packages/platform/src/customer-vps-host-config.js';

const config = loadCustomerVpsConfig({
  PLATFORM_PORT: '9000',
  PLATFORM_SECRET: 'platform-secret',
  HETZNER_API_TOKEN: 'token',
  S3_ACCESS_KEY_ID: 'r2-access-key',
  S3_SECRET_ACCESS_KEY: 'r2-secret-key',
  S3_ENDPOINT: 'https://r2.example',
  R2_BUCKET: 'matrixos-sync',
});
const bundleRef = {
  imageVersion: 'v2026.09.28-pr1907-1-1-abcdef0',
  hostBundleUrl: 'https://app.matrix-os.com/system-bundles/v2026.09.28-pr1907-1-1-abcdef0/matrix-host-bundle.tar.gz',
};

function hostConfig(handle: string, provisioningClass?: 'customer' | 'preview' | 'private-preview') {
  return buildHostConfig(
    config,
    { clerkUserId: 'user_owner', handle, runtimeSlot: handle, developerTools: [], ...(provisioningClass ? { provisioningClass } : {}) },
    '00000000-0000-4000-8000-000000001907',
    'r'.repeat(64),
    '2026-09-28T01:00:00.000Z',
    'p'.repeat(48),
    bundleRef as never,
  );
}

function envLines(rendered: string): string[] {
  return rendered.split('\n').map((line) => line.trim()).filter(Boolean);
}

describe('Private Preview host environment', () => {
  const origin = new URL(config.platformRegisterUrl).origin;

  it.each([
    ['the built-in template', async () => DEFAULT_CLOUD_INIT_TEMPLATE],
    ['the production template', () => loadCustomerVpsCloudInitTemplate()],
  ])('points %s at the per-machine update base and disables collaboration', async (_label, load) => {
    const handle = 'pv-1907-3fa91c2e';
    const lines = envLines(renderCloudInitTemplate(await load(), hostConfig(handle, 'private-preview')));
    expect(lines).toContain(`MATRIX_UPDATE_MANIFEST_BASE_URL=${origin}/private-preview-updates/${handle}`);
    expect(lines).toContain('MATRIX_COLLABORATION_DISABLED=1');
    expect(lines.join('\n')).not.toMatch(/\{\{[a-zA-Z0-9_]+\}\}/);
  });

  it.each([undefined, 'customer', 'preview'] as const)('leaves %s machines on the default update base', async (provisioningClass) => {
    for (const template of [DEFAULT_CLOUD_INIT_TEMPLATE, await loadCustomerVpsCloudInitTemplate()]) {
      const rendered = renderCloudInitTemplate(template, hostConfig('alice', provisioningClass));
      // An empty assignment would override the gateway's fallback, so the keys must be absent.
      expect(rendered).not.toContain('MATRIX_UPDATE_MANIFEST_BASE_URL');
      expect(rendered).not.toContain('MATRIX_COLLABORATION_DISABLED');
      expect(rendered).not.toMatch(/\{\{[a-zA-Z0-9_]+\}\}/);
    }
  });

  it('keeps a Private Preview user_data under the Hetzner limit with headroom', async () => {
    const longest = hostConfig('pv-999999999-ffffffff', 'private-preview');
    const rendered = renderCloudInitTemplate(await loadCustomerVpsCloudInitTemplate(), {
      ...longest,
      clerkUserId: 'user_2abcdefghijklmnopqrstuvwxyz012345',
      platformVerificationToken: 'v'.repeat(64),
      syncRuntimeToken: 's'.repeat(64),
      fundedAiRuntimeToken: 'f'.repeat(64),
    });
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(32_768 - 1_024);
  });
});
