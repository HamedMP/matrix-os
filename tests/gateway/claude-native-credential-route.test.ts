import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildKernelCredentialLaunch, KernelCredentialAccessSourceIdSchema } from '../../packages/gateway/src/kernel-credentials.js';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(profile = true) {
  const home = await mkdtemp(join(tmpdir(), 'matrix-claude-native-credential-')); homes.push(home);
  await mkdir(join(home, 'system/ai-providers'), { recursive: true });
  await writeFile(join(home, 'system/ai-providers/anthropic-key.json'), JSON.stringify({ version: 1, apiKey: 'sk-ant-test-owner' }), { mode: 0o600 });
  if (profile) await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-profile-only' } }));
  return home;
}
describe('native Claude credential source routing', () => {
  it('recognizes the explicit native account source without changing historical source names', () => {
    expect(KernelCredentialAccessSourceIdSchema.parse('owner_claude_profile')).toBe('owner_claude_profile');
    expect(KernelCredentialAccessSourceIdSchema.parse('owner_anthropic_profile')).toBe('owner_anthropic_profile');
  });
  it('uses the same owner profile as the historical route despite a saved or ambient API key', async () => {
    const home = await fixture();
    const environment = { ANTHROPIC_API_KEY: 'ambient-must-not-win', ANTHROPIC_AUTH_TOKEN: 'ambient-token', CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth', ANTHROPIC_BASE_URL: 'https://other.test', CLAUDE_CONFIG_DIR: '/other/profile' };
    const native = await buildKernelCredentialLaunch(home, environment, 'owner_claude_profile', undefined, { requestClass: 'interactive' });
    const legacy = await buildKernelCredentialLaunch(home, environment, 'owner_anthropic_profile', undefined, { requestClass: 'interactive' });
    expect(native.env).toMatchObject({ HOME: home });
    expect(native.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(native.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(native.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(native.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(native.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    const legacyEnvironment = { ...legacy.env };
    delete legacyEnvironment.CLAUDE_CONFIG_DIR;
    expect(legacyEnvironment).toEqual(native.env);
    const key = await buildKernelCredentialLaunch(home, environment, 'owner_anthropic_key', undefined, { requestClass: 'interactive' });
    expect(key.env?.ANTHROPIC_API_KEY).toBe('sk-ant-test-owner');
  });
  it('fails closed when the requested native profile is absent instead of charging an API key', async () => {
    const home = await fixture(false);
    await expect(buildKernelCredentialLaunch(home, { ANTHROPIC_API_KEY: 'ambient' }, 'owner_claude_profile', undefined, { requestClass: 'interactive' })).rejects.toThrow('Selected AI access is unavailable');
  });
});
