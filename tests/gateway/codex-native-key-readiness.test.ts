import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { createCodexNativeKeyReadinessReader } from '../../packages/gateway/src/ai-providers/codex-native-key-readiness.js';
import { AiProviderService } from '../../packages/gateway/src/ai-providers/service.js';
let home = '';
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });
async function fixture(document: object) { home = await mkdtemp(join(tmpdir(), 'native-key-')); await mkdir(join(home, '.codex')); await writeFile(join(home, '.codex/auth.json'), JSON.stringify(document)); }
describe('native key readiness', () => {
  it('never treats subscription credential metadata as a verified key', async () => { await fixture({ tokens: { access_token: 'synthetic' } }); const reader = createCodexNativeKeyReadinessReader({ homePath: home, fetchFn: async () => { throw new Error('must not fetch'); } }); expect(await reader()).toBeNull(); });
  it('rejects a changed credential during probe without exposing either key', async () => { await fixture({ OPENAI_API_KEY: 'sk-synthetic-old', auth_mode: 'apikey' }); const reader = createCodexNativeKeyReadinessReader({ homePath: home, fetchFn: async () => { await writeFile(join(home, '.codex/auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-synthetic-new' })); return new Response('{}'); } }); expect(await reader()).toBeNull(); });
  it('projects explicit native key mode with unchanged durable account/source/instance IDs', async () => {
    await fixture({ OPENAI_API_KEY: 'sk-synthetic-key', auth_mode: 'apikey' });
    const now = new Date('2026-10-01T00:00:00Z');
    const reader = createCodexNativeKeyReadinessReader({ homePath: home, now: () => now, fetchFn: async () => new Response('{}') });
    const service = new AiProviderService({ homePath: home, env: {}, now: () => now, codexNativeKeyReadiness: reader });
    const snapshot = await service.getSnapshot();
    expect(snapshot.accessSources.find(s => s.id === 'owner_openai_profile')).toMatchObject({ fundingKind: 'owner_api_key', displayName: 'OpenAI API key', state: 'ready' });
    expect(snapshot.accounts.find(a => a.id === 'owner_codex')).toMatchObject({ authMethod: 'api_key' });
    expect(JSON.stringify(snapshot)).not.toContain('sk-synthetic'); service.close();
  });
});
it('rejects a changed credential even when its old probe fails', async () => {
  await fixture({ OPENAI_API_KEY: 'sk-synthetic-old' });
  const reader = createCodexNativeKeyReadinessReader({ homePath: home, fetchFn: async () => {
    await writeFile(join(home, '.codex/auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-synthetic-new' }));
    throw new Error('synthetic network failure');
  } });
  expect(await reader()).toBeNull();
});
