import { expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexNativeEnvironment } from '../../packages/gateway/src/ai-providers/codex-native-environment.js';
it('uses one exact owner profile and strips provider credentials and foreign ambient homes', () => {
  expect(codexNativeEnvironment('/owner', { HOME: '/foreign', CODEX_HOME: '/foreign/codex', OPENAI_API_KEY: 'synthetic', CODEX_API_KEY: 'synthetic', PATH: '/bin' }, '/owner/profiles/codex')).toEqual({ HOME: '/owner', MATRIX_HOME: '/owner', CODEX_HOME: '/owner/profiles/codex', PATH: '/bin' });
  for (const path of ['relative', '/foreign', '/owner', '/owner/../foreign']) expect(() => codexNativeEnvironment('/owner', {}, path)).toThrow('Native Codex profile is unavailable');
});
it('rejects a profile path escaping through a symlink without reading credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-codex-environment-'));
  try { await symlink(tmpdir(), join(root, 'escape')); expect(() => codexNativeEnvironment(root, {}, join(root, 'escape/profile'))).toThrow('Native Codex profile is unavailable'); }
  finally { await rm(root, { recursive: true, force: true }); }
});
