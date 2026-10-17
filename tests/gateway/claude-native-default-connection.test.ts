import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AiProviderService } from '../../packages/gateway/src/ai-providers/service.js';
import { ProviderSettingsStore } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
import { createClaudeNativeAccountMetadataReader } from '../../packages/gateway/src/ai-providers/claude-native-account-metadata.js';
import { hasConfiguredConnection, resolveHarnessConnection } from '../../packages/ui/src/agents-providers/harness-connection.js';
import { resolvedWorkflowRowStatus } from '../../packages/ui/src/agents-providers/workflow-row-status.js';
import { initialProviderSettingsConfiguration } from '../../packages/gateway/src/ai-providers/provider-settings-persistence.js';
import { providerSettingsCanonicalFixture } from './provider-settings-test-support.js';

const roots: string[] = [], services: AiProviderService[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claude-default-connection-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home);
  await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account' } }));
  let loggedIn = true;
  const reader = createClaudeNativeAccountMetadataReader({ executable: '/fixture/claude', cwd: home, environment: { HOME: home },
    runCommand: async () => ({ stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty',
      email: 'fixture@example.invalid', configDirectory: join(home, '.claude') }) }) });
  const service = new AiProviderService({ homePath: home, env: {}, exposeClaudeProfileAccount: true,
    driverInventory: async () => [{ id: 'claude_code', displayName: 'Claude Code', installState: 'installed', kind: 'cli', health: 'unknown', capabilities: ['tools', 'resume'], setupActions: [] }] });
  services.push(service);
  const store = new ProviderSettingsStore({ homePath: home, privateRootPath: join(root, 'private'), providerSnapshotReader: service, claudeNativeAccountMetadataReader: reader });
  const snapshot = () => store.getSnapshot({ refresh: true, includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
  return { store, snapshot, signOut: () => { loggedIn = false; } };
}

it('shows an already authenticated native Claude account in the generated row without requiring another login or inference probe', async () => {
  const f = await fixture(), snapshot = await f.snapshot();
  const harness = snapshot.harnesses.find(row => row.harness === 'claude')!;
  const { account, source } = resolveHarnessConnection(harness, snapshot.accounts, snapshot.accessSources);
  expect(account).toMatchObject({ id: 'owner_claude_profile', authState: 'authenticated' });
  expect(harness).toMatchObject({ accessSourceId: 'owner_claude_profile', selectedAccountId: account!.id, authState: 'authenticated' });
  expect(hasConfiguredConnection(harness, source)).toBe(true);
  expect(resolvedWorkflowRowStatus(harness, source)).toBe('Connected');
  expect(source!.readiness.state).toBe('unknown');
  f.signOut();
  const signedOut = await f.snapshot();
  expect(hasConfiguredConnection(signedOut.harnesses.find(row => row.id === harness.id)!, signedOut.accessSources.find(row => row.id === source!.id))).toBe(false);
});

it.each([true, false])('reconciles only the old generated native profile alias and preserves enabled=%s', async enabled => {
  const f = await fixture(); await f.snapshot();
  const config = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  const row = config.harnesses.find((item: { harness: string }) => item.harness === 'claude');
  Object.assign(row, { accessSourceId: 'owner_anthropic_profile', selectedAccountId: 'owner_anthropic', enabled, enablementOrigin: 'generated_default' });
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  const after = await f.snapshot();
  expect(after.harnesses.find(item => item.id === row.id)).toMatchObject({ configuredAccessSourceId: 'owner_claude_profile', selectedAccountId: 'owner_claude_profile', configuredEnabled: enabled, authState: 'authenticated' });
});

it.each(['owner_anthropic_profile', 'owner_anthropic_key', 'matrix_included'])('preserves an explicit owner selection of %s', async accessSourceId => {
  const f = await fixture(); await f.snapshot();
  const config = JSON.parse(await readFile(f.store.configurationPath, 'utf8'));
  const row = config.harnesses.find((item: { harness: string }) => item.harness === 'claude');
  Object.assign(row, { accessSourceId, selectedAccountId: accessSourceId === 'matrix_included' ? null : 'owner_anthropic', enablementOrigin: 'owner_configuration' });
  await writeFile(f.store.configurationPath, JSON.stringify(config));
  await f.snapshot();
  expect(JSON.parse(await readFile(f.store.configurationPath, 'utf8')).harnesses.find((item: { id: string }) => item.id === row.id)).toEqual(row);
});

it.each(['matrix_included', 'owner_anthropic_key'])('keeps an active %s source when the installed native account is signed out', accessSourceId => {
  const canonical = providerSettingsCanonicalFixture();
  const profile = canonical.accessSources.find(source => source.id === 'owner_anthropic_profile')!;
  canonical.accessSources.push({ ...profile, id: 'owner_claude_profile', state: 'setup_required' });
  canonical.accounts.push({ ...canonical.accounts[0]!, id: 'owner_claude_profile', state: 'setup_required' });
  canonical.instances.push({ ...canonical.instances[0]!, id: 'native_claude', driverId: 'claude_code', accountId: 'owner_claude_profile', accessSourceId: 'owner_claude_profile' });
  if (accessSourceId === 'owner_anthropic_key') canonical.accessSources.push({ ...profile, id: accessSourceId, fundingKind: 'owner_api_key' });
  canonical.active.accessSourceId = accessSourceId;
  expect(initialProviderSettingsConfiguration(canonical).harnesses.find(row => row.harness === 'claude')?.accessSourceId).toBe(accessSourceId);
});
