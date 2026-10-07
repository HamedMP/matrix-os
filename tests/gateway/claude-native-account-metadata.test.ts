import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeNativeAccountMetadataReader, normalizeClaudeNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/claude-native-account-metadata.js';
import { createClaudeNativeUsageReader } from '../../packages/gateway/src/ai-providers/claude-native-usage.js';
import { verifyNativeAccountMetadata } from '../../packages/gateway/src/ai-providers/native-account-metadata-binding.js';
import { AiProviderService } from '../../packages/gateway/src/ai-providers/service.js';
import { projectProviderSettings } from '../../packages/gateway/src/ai-providers/provider-settings-projector.js';
import { initialProviderSettingsConfiguration } from '../../packages/gateway/src/ai-providers/provider-settings-persistence.js';
import { providerSettingsCanonicalFixture, PROVIDER_SETTINGS_NOW as now } from './provider-settings-test-support.js';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const status = (home: string) => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.test', orgId: 'org-own', subscriptionType: 'max', configDirectory: join(home, '.claude') });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'matrix-claude-auth-reader-')); homes.push(home);
  const runCommand = vi.fn(async () => ({ stdout: JSON.stringify(status(home)) }));
  const assertProfileAvailable = vi.fn(async () => {});
  const read = createClaudeNativeAccountMetadataReader({ executable: '/native/claude', cwd: home, environment: { HOME: home, PATH: '/native/bin', ANTHROPIC_API_KEY: 'must-not-pass', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass', CLAUDE_CONFIG_DIR: '/other/profile' }, now: () => now, runCommand, assertProfileAvailable });
  return { home, runCommand, assertProfileAvailable, read };
}
function nativeCanonical() {
  const canonical = providerSettingsCanonicalFixture();
  const source = canonical.accessSources.find(source => source.id === 'owner_anthropic_profile')!;
  const unknown = { state: 'unknown' as const, checkedAt: null, staleAfter: null, action: 'retry' as const, safeReason: 'unknown' as const };
  canonical.accessSources.push({ ...source, id: 'owner_claude_profile', ...unknown });
  canonical.accounts.push({ ...canonical.accounts[0]!, id: 'owner_claude_profile', authMethod: 'provider_profile', ...unknown });
  canonical.instances.push({ ...canonical.instances.find(instance => instance.accessSourceId === source.id)!, id: 'claude_code_owner_profile', driverId: 'claude_code', accountId: 'owner_claude_profile', accessSourceId: 'owner_claude_profile', readiness: unknown });
  for (const model of canonical.models) if (model.eligibleAccessSourceIds.includes(source.id)) {
    model.eligibleAccessSourceIds.push('owner_claude_profile');
    model.dataPolicies.push({ ...model.dataPolicies.find(policy => policy.accessSourceId === source.id)!, accessSourceId: 'owner_claude_profile' });
  }
  return canonical;
}
describe('exact owner Claude native subscription status', () => {
  it('accepts only allowlisted account fields from official CLI subscription status', () => {
    const metadata = normalizeClaudeNativeAccountMetadata({ ...status('/owner'), accessToken: 'secret', unknown: 'do not expose' }, '/owner', now);
    expect(metadata).toEqual({ accountLabel: 'owner@example.test', authMethod: 'terminal', connectionDetails: { email: 'owner@example.test', planName: 'Claude Max' }, checkedAt: now.toISOString(), staleAfter: new Date(+now + 30_000).toISOString() });
    expect(JSON.stringify(metadata)).not.toMatch(/org-own|secret|\/owner|do not expose/);
  });
  it.each([
    { loggedIn: false }, { authMethod: 'api_key' }, { authMethod: 'none' }, { apiProvider: 'bedrock' }, { apiProvider: 'vertex' }, { configDirectory: '/other/profile' }, { email: 'invalid' }, { subscriptionType: 'made up plan' },
  ])('fails closed for ambiguous or unrelated identity %j', patch => {
    const metadata = normalizeClaudeNativeAccountMetadata({ ...status('/owner'), ...patch }, '/owner', now);
    if (patch.subscriptionType) expect(metadata?.connectionDetails?.planName).toBeUndefined();
    else expect(metadata).toBeNull();
  });
  it('binds real quota to the exact native account without copying it to other sources', async () => {
    const canonical = nativeCanonical(); const config = initialProviderSettingsConfiguration(canonical);
    const metadata = normalizeClaudeNativeAccountMetadata(status('/owner'), '/owner', now)!;
    metadata.usage = {kind:'subscription_allowance',authority:'provider_allowance',state:'current',scope:'account',usedBasisPoints:300,resetsAt:new Date(+now+3600000).toISOString(),asOf:now.toISOString()};
    const result = await projectProviderSettings({canonical,config,now,supportedActions:[],claudeNativeAccountMetadata:metadata});
    expect(result.accessSources.find(source=>source.id==='owner_claude_profile')?.usage).toEqual(metadata.usage);
    expect(result.accessSources.find(source=>source.id==='owner_anthropic_profile')?.usage).not.toEqual(metadata.usage);
  });
  it('reads quota only for requested snapshots and rechecks principal after quota', async () => {
    const f = await fixture();
    const usage = {kind:'subscription_allowance',authority:'provider_allowance',state:'current',scope:'account',usedBasisPoints:300,resetsAt:new Date(+now+3600000).toISOString(),asOf:now.toISOString()} as const;
    const isCurrent = vi.fn(async()=>true); const usageReader = vi.fn(async()=>({usage,isCurrent}));
    const read = createClaudeNativeAccountMetadataReader({executable:'/native/claude',cwd:f.home,environment:{HOME:f.home},now:()=>now,runCommand:f.runCommand,assertProfileAvailable:f.assertProfileAvailable,usageReader});
    expect((await read())?.usage).toBeUndefined();expect(usageReader).not.toHaveBeenCalled();
    const metadata = await read(true);expect(metadata?.usage).toEqual(usage);
    expect(await verifyNativeAccountMetadata(metadata)).toEqual(metadata);
    isCurrent.mockResolvedValue(false);expect(await verifyNativeAccountMetadata(metadata)).toBe(metadata);expect(metadata?.usage).toBeUndefined();
    usageReader.mockImplementation(async()=>{f.runCommand.mockResolvedValue({stdout:JSON.stringify({...status(f.home),email:'other@example.test'})});return {usage,isCurrent};});
    expect(await read(true)).toBeNull();
  });
  it.each([
    ['initial observation', 'reset'], ['initial observation', 'credential refresh'],
    ['late binding', 'reset'], ['late binding', 'credential refresh'],
  ] as const)('keeps current CLI identity but drops invalid quota after %s: %s', async (phase, invalidation) => {
    const f = await fixture();
    let time = now;
    await mkdir(join(f.home, '.claude'), {mode:0o700});
    const path = join(f.home, '.claude/.credentials.json');
    const credentials = {claudeAiOauth:{accessToken:'fixture-secret',expiresAt:+now+3600000,scopes:['user:profile']}};
    await writeFile(path, JSON.stringify(credentials), {mode:0o600});
    const reset = new Date(+now+1000).toISOString();
    const fetcher = vi.fn(async()=>new Response(JSON.stringify({five_hour:{utilization:3,resets_at:reset}})));
    const usageReader = createClaudeNativeUsageReader({homePath:f.home,now:()=>time,fetch:fetcher});
    let observations = 0;
    f.runCommand.mockImplementation(async()=>{
      observations++;
      if (observations === (phase === 'initial observation' ? 2 : 3)) {
        if (invalidation === 'reset') time = new Date(reset);
        else await writeFile(path,JSON.stringify({claudeAiOauth:{...credentials.claudeAiOauth,accessToken:'replacement'}}));
      }
      return {stdout:JSON.stringify(status(f.home))};
    });
    const read = createClaudeNativeAccountMetadataReader({executable:'/native/claude',cwd:f.home,environment:{HOME:f.home},now:()=>time,runCommand:f.runCommand,assertProfileAvailable:f.assertProfileAvailable,usageReader});
    const metadata = await read(true);
    expect(metadata?.connectionDetails).toEqual({email:'owner@example.test',planName:'Claude Max'});
    if (phase === 'late binding') expect(metadata?.usage?.usedBasisPoints).toBe(300);
    const verified = await verifyNativeAccountMetadata(metadata);
    expect(verified).toBe(metadata);
    expect(verified?.usage).toBeUndefined();
    const canonical = nativeCanonical(); const config = initialProviderSettingsConfiguration(canonical);
    const projected = await projectProviderSettings({canonical,config,now:time,supportedActions:[],claudeNativeAccountMetadata:verified});
    expect(projected.accounts.find(account=>account.id==='owner_claude_profile')).toMatchObject({authState:'authenticated',displayName:'owner@example.test',connectionDetails:{planName:'Claude Max'}});
    expect(projected.accessSources.find(source=>source.id==='owner_claude_profile')?.usage.kind).toBe('unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects a changed principal during late quota binding', async () => {
    const f = await fixture();
    const usage = {kind:'subscription_allowance',authority:'provider_allowance',state:'current',scope:'account',usedBasisPoints:300,resetsAt:new Date(+now+3600000).toISOString(),asOf:now.toISOString()} as const;
    const read = createClaudeNativeAccountMetadataReader({executable:'/native/claude',cwd:f.home,environment:{HOME:f.home},now:()=>now,runCommand:f.runCommand,assertProfileAvailable:f.assertProfileAvailable,usageReader:async()=>({usage,isCurrent:async()=>true})});
    const metadata = await read(true);
    f.runCommand.mockResolvedValue({stdout:JSON.stringify({...status(f.home),orgId:'another-org'})});
    expect(await verifyNativeAccountMetadata(metadata)).toBeNull();
  });
  it('keeps confirmed identity when the quota endpoint is unavailable', async () => {
    const f=await fixture();
    const read=createClaudeNativeAccountMetadataReader({executable:'/native/claude',cwd:f.home,environment:{HOME:f.home},now:()=>now,runCommand:f.runCommand,assertProfileAvailable:f.assertProfileAvailable,usageReader:async()=>null});
    const metadata=await read(true);expect(metadata?.connectionDetails?.planName).toBe('Claude Max');expect(metadata?.usage).toBeUndefined();expect(await verifyNativeAccountMetadata(metadata)).toEqual(metadata);
  });
  it('uses exact runtime profile and strips all credential/provider env fallbacks', async () => {
    const f = await fixture(); const metadata = await f.read();
    expect(await verifyNativeAccountMetadata(metadata)).toEqual(metadata);
    expect(f.runCommand).toHaveBeenCalledWith('/native/claude', ['auth', 'status', '--json'], expect.objectContaining({ cwd: f.home, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 8192, env: { HOME: f.home, PATH: '/native/bin' } }));
    expect(f.assertProfileAvailable).toHaveBeenCalled();
  });
  it('bounds and reaps a real native status process that never returns', async () => {
    const f = await fixture(); const executable = join(f.home, 'status-never-finishes');
    await writeFile(executable, '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o700 });
    const read = createClaudeNativeAccountMetadataReader({ executable, cwd: f.home, environment: { HOME: f.home }, now: () => now, timeoutMs: 50 });
    const started = Date.now(); expect(await read()).toBeNull(); expect(Date.now() - started).toBeLessThan(1500);
    expect(await read()).toBeNull();
  });
  it('rechecks a changed organization even when the email is unchanged', async () => {
    const f = await fixture(); const metadata = await f.read();
    f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...status(f.home), orgId: 'another-org' }) });
    expect(await verifyNativeAccountMetadata(metadata)).toBeNull();
  });
  it('rejects a writer that starts while the native observation is in flight', async () => {
    const f = await fixture(); f.assertProfileAvailable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('writer in progress'));
    expect(await f.read()).toBeNull();
  });
  it('coalesces concurrent account reads without persisting identity across calls', async () => {
    const f = await fixture(); const observations = await Promise.all([f.read(), f.read(), f.read()]);
    expect(observations.every(value => value === observations[0])).toBe(true);
    expect(f.runCommand).toHaveBeenCalledTimes(1);
    await f.read(); expect(f.runCommand).toHaveBeenCalledTimes(2);
  });
  it('revokes identity after native account/logout/profile switch', async () => {
    const f = await fixture(); const metadata = await f.read();
    f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...status(f.home), email: 'other@example.test' }) });
    expect(await verifyNativeAccountMetadata(metadata)).toBeNull();
    f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ ...status(f.home), loggedIn: false }) });
    expect(await f.read()).toBeNull();
  });
  it('does not authorize file metadata without a native CLI verdict', async () => {
    const f = await fixture(); await mkdir(join(f.home, '.claude'));
    await writeFile(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'native-marker', emailAddress: 'owner@example.test' } }));
    f.runCommand.mockResolvedValue({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) });
    expect(await f.read()).toBeNull();
  });
  it('rejects native metadata observed across another native writer', async () => {
    const f = await fixture(); const metadata = await f.read();
    f.assertProfileAvailable.mockRejectedValue(new Error('writer in progress'));
    expect(await verifyNativeAccountMetadata(metadata)).toBeNull();
    expect(await f.read()).toBeNull();
  });
  it('returns null for nonzero native failures or malformed/oversized output without raw details', async () => {
    const f = await fixture(); f.runCommand.mockRejectedValue(new Error('secret or path'));
    expect(await f.read()).toBeNull();
    f.runCommand.mockResolvedValue({ stdout: 'garbage' }); expect(await f.read()).toBeNull();
    f.runCommand.mockResolvedValue({ stdout: ' '.repeat(8193) }); expect(await f.read()).toBeNull();
  });
  it('keeps owner API keys distinct when a native Claude profile account is registered', async () => {
    const f = await fixture(); await mkdir(join(f.home, 'system/ai-providers'), { recursive: true }); await writeFile(join(f.home, 'system/ai-providers/anthropic-key.json'), JSON.stringify({ version: 1, apiKey: 'sk-ant-owner-key' }), { mode: 0o600 });
    const driver = { id: 'claude_code', displayName: 'Claude Code', kind: 'cli' as const, installState: 'installed' as const, health: 'unknown' as const, capabilities: ['tools' as const], setupActions: [] };
    const base = new AiProviderService({ homePath: f.home, env: {}, now: () => now, driverInventory: async () => [driver] });
    const registered = new AiProviderService({ homePath: f.home, env: {}, now: () => now, driverInventory: async () => [driver], exposeClaudeProfileAccount: true });
    try {
      const original = await base.getSnapshot(); const after = await registered.getSnapshot();
      expect(after.accounts.find(account => account.id === 'owner_anthropic')?.authMethod).toBe('api_key');
      expect(after.accounts.find(account => account.id === 'owner_anthropic')).toEqual(original.accounts.find(account => account.id === 'owner_anthropic'));
      expect(after.accounts.find(account => account.id === 'owner_claude_profile')).toMatchObject({ authMethod: 'provider_profile', accountLabel: 'Claude account', state: 'unknown' });
      expect(after.accessSources.filter(source => original.accessSources.some(old => old.id === source.id))).toEqual(original.accessSources);
      expect(after.instances.find(instance => instance.accessSourceId === 'owner_anthropic_key')?.accountId).toBe('owner_anthropic');
      expect(after.instances.filter(instance => original.instances.some(old => old.id === instance.id))).toEqual(original.instances);
      expect(after.instances.find(instance => instance.id === 'claude_code_owner_profile')?.accountId).toBe('owner_claude_profile');
      const config = initialProviderSettingsConfiguration(original); const legacy = config.harnesses.find(row => row.harness === 'claude')!;
      legacy.enabled = false; const before = structuredClone(legacy);
      await projectProviderSettings({ canonical: after, config, now, supportedActions: [], claudeNativeAccountMetadata: normalizeClaudeNativeAccountMetadata(status(f.home), f.home, now) });
      expect(legacy).toEqual(before);
    } finally { base.close(); registered.close(); }
  });
  it.each(['expired', 'missing_driver', 'wrong_account', 'wrong_source', 'api_method', 'other_harness'] as const)('does not transfer subscription proof when %s', async mismatch => {
    const canonical = nativeCanonical(); const config = initialProviderSettingsConfiguration(canonical);
    const row = config.harnesses.find(row => row.harness === 'claude')!;
    row.accessSourceId = 'owner_claude_profile'; row.selectedAccountId = 'owner_claude_profile';
    if (mismatch === 'missing_driver') canonical.drivers.find(driver => driver.id === 'claude_code')!.installState = 'missing';
    if (mismatch === 'wrong_account') canonical.instances.find(instance => instance.id === 'claude_code_owner_profile')!.accountId = null;
    if (mismatch === 'wrong_source') canonical.instances.find(instance => instance.id === 'claude_code_owner_profile')!.accessSourceId = 'other';
    if (mismatch === 'api_method') { canonical.accounts.find(account => account.id === 'owner_claude_profile')!.authMethod = 'api_key'; config.accountProfiles.find(account => account.id === 'owner_claude_profile')!.authMethod = 'api_key'; }
    if (mismatch === 'other_harness') row.harness = 'opencode';
    const metadata = normalizeClaudeNativeAccountMetadata(status('/owner'), '/owner', now)!;
    if (mismatch === 'expired') metadata.staleAfter = now.toISOString();
    const snapshot = await projectProviderSettings({ canonical, config, now, supportedActions: [], claudeNativeAccountMetadata: metadata });
    expect(snapshot.harnesses.find(harness => harness.id === row.id)?.authState).not.toBe('authenticated');
    if (mismatch !== 'other_harness') expect(snapshot.accounts.find(account => account.id === 'owner_claude_profile')?.connectionDetails).toBeUndefined();
    expect(snapshot.accounts.find(account => account.id === 'owner_anthropic')?.connectionDetails).toBeUndefined();
  });
  it('preserves saved legacy Claude and Hermes profile bindings when native metadata is introduced', async () => {
    const f = await fixture(); await mkdir(join(f.home, 'system')); await writeFile(join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'native-marker', emailAddress: 'owner@example.test' } }));
    const inventory = [
      { id: 'claude_code', displayName: 'Claude Code', kind: 'cli' as const, installState: 'installed' as const, health: 'unknown' as const, capabilities: ['tools' as const], setupActions: [] },
      { id: 'hermes', displayName: 'Hermes', kind: 'cli' as const, installState: 'installed' as const, health: 'degraded' as const, capabilities: ['tools' as const], setupActions: [], nativeRouteObservation: { providerId: 'anthropic', modelId: 'claude-sonnet-5', credentialKind: 'provider_profile' as const, localObservation: { state: 'present_unverified' as const, checkedAt: now.toISOString(), staleAfter: new Date(+now + 5000).toISOString() } } },
    ];
    const beforeReader = new AiProviderService({ homePath: f.home, env: {}, now: () => now, driverInventory: async () => inventory });
    const afterReader = new AiProviderService({ homePath: f.home, env: {}, now: () => now, driverInventory: async () => inventory, exposeClaudeProfileAccount: true });
    try {
      const before = await beforeReader.getSnapshot(); const canonical = await afterReader.getSnapshot();
      expect(canonical.instances.filter(instance => before.instances.some(old => old.id === instance.id))).toEqual(before.instances);
      const config = initialProviderSettingsConfiguration(before);
      const claude = config.harnesses.find(row => row.harness === 'claude')!;
      Object.assign(claude, { enabled: false, accessSourceId: 'owner_anthropic_profile', selectedAccountId: 'owner_anthropic' });
      config.harnesses.push({ ...claude, id: 'legacy_hermes', harness: 'hermes', driverId: 'hermes', enabled: true, route: { kind: 'configurable', providerId: 'anthropic', modelId: 'claude-sonnet-5' } });
      const intent = structuredClone(config);
      const metadata = normalizeClaudeNativeAccountMetadata(status(f.home), f.home, now);
      const after = await projectProviderSettings({ canonical, config, now, supportedActions: [], claudeNativeAccountMetadata: metadata });
      expect(after.accessSources.find(source => source.id === 'owner_anthropic_profile')?.accountId).toBe('owner_anthropic');
      expect(after.harnesses.find(row => row.id === claude.id)).toMatchObject({ selectedAccountId: 'owner_anthropic', configuredEnabled: false, enabled: false });
      expect(after.harnesses.find(row => row.id === 'legacy_hermes')).toMatchObject({ selectedAccountId: 'owner_anthropic', localObservation: inventory[1]!.nativeRouteObservation!.localObservation });
      expect(config).toEqual(intent);
    } finally { beforeReader.close(); afterReader.close(); }
  });
  it('authenticates the exact Claude profile account independently of unknown remote readiness', async () => {
    const canonical = nativeCanonical(); const config = initialProviderSettingsConfiguration(canonical);
    const row = config.harnesses.find(row => row.harness === 'claude')!;
    row.enabled = false; row.accessSourceId = 'owner_claude_profile'; row.selectedAccountId = 'owner_claude_profile';
    const result = await projectProviderSettings({ canonical, config, now, supportedActions: [], claudeNativeAccountMetadata: normalizeClaudeNativeAccountMetadata(status('/owner'), '/owner', now) });
    expect(result.accounts.find(account => account.id === 'owner_claude_profile')).toMatchObject({ authState: 'authenticated', authMethod: 'terminal', displayName: 'owner@example.test', accessSourceId: 'owner_claude_profile' });
    expect(result.harnesses.find(row => row.harness === 'claude')).toMatchObject({ authState: 'authenticated', configuredEnabled: false, enabled: false, connectivity: 'unknown' });
    expect(result.accessSources.find(source => source.id === 'owner_claude_profile')?.readiness.state).toBe('unknown');
    expect(result.accounts.find(account => account.id === 'owner_anthropic')?.connectionDetails).toBeUndefined();
  });
});
