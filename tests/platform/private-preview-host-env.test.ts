import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { admitsHostedBotsPrivatePreview } from '../../packages/gateway/src/hosted-bots/preview-admission.js';
import {
  loadCustomerVpsCloudInitTemplate,
  renderCloudInitTemplate,
} from '../../packages/platform/src/customer-vps-cloud-init.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { DEFAULT_CLOUD_INIT_TEMPLATE, buildHostConfig } from '../../packages/platform/src/customer-vps-host-config.js';

const config = loadCustomerVpsConfig({
  PLATFORM_PUBLIC_URL: 'https://app.matrix-os.com',
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

  it('marks both server-authorized Preview classes as bounded Preview runtimes', async () => {
    for (const template of [DEFAULT_CLOUD_INIT_TEMPLATE, await loadCustomerVpsCloudInitTemplate()]) {
      expect(envLines(renderCloudInitTemplate(template, hostConfig('pr-2383', 'preview'))))
        .toContain('MATRIX_PREVIEW_RUNTIME=true');
      expect(renderCloudInitTemplate(template, hostConfig('alice', 'customer')))
        .not.toContain('MATRIX_PREVIEW_RUNTIME');
      expect(envLines(renderCloudInitTemplate(template, hostConfig('pv-1907-3fa91c2e', 'private-preview'))))
        .toContain('MATRIX_PREVIEW_RUNTIME=true');
    }
  });

  it.each([
    ['private-preview', 'pv-1907-3fa91c2e', true],
    ['preview', 'pr-1907', false],
    ['customer', 'alice', false],
  ] as const)('uses the actual %s host environment to gate Hosted Bots', async (provisioningClass, handle, expected) => {
    const template = await loadCustomerVpsCloudInitTemplate();
    const rendered = renderCloudInitTemplate(template, hostConfig(handle, provisioningClass));
    const cloudInit = parse(rendered) as { write_files: Array<{ path: string; content: string }> };
    const host = cloudInit.write_files.find((file) => file.path === '/opt/matrix/env/host.env');
    expect(host).toBeDefined();
    const lines = envLines(host!.content).filter((line) => line.includes('='));
    const env = Object.fromEntries(lines.map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    expect(admitsHostedBotsPrivatePreview(env)).toBe(expected);
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
