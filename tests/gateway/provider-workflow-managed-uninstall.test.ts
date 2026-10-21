import { expect, it, vi } from 'vitest';
import type { TerminalRuntimeSocketClient } from '@matrix-os/terminal-runtime';
import type { ProviderSettingsStoreWriter } from '../../packages/gateway/src/ai-providers/provider-settings-store.js';
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
  realpath: async (path: string) => path,
}));
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
it('removes the fixed managed CLI package without invoking owner-data lifecycle scripts', async () => {
  const createTab = vi.fn<(...args: Parameters<TerminalRuntimeSocketClient['createTab']>) => Promise<{ workspaceId: string; id: string; incarnation: string }>>(async () => ({ workspaceId: 'tws_test', id: 'tt_test', incarnation: 'ti_test' }));
  const terminal = { ensureWorkspace: async () => ({ id: 'tws_test' }), createTab, terminateTab: async () => {}, attach: () => ({ close: vi.fn(), send: vi.fn() }), listWorkspaces: async () => [] } as unknown as Pick<TerminalRuntimeSocketClient, 'ensureWorkspace' | 'createTab' | 'terminateTab' | 'attach' | 'listWorkspaces'>;
  const store = { getSnapshot: async () => ({ access: { mode: 'writable' }, harnesses: [{ id: 'codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: [], selectedAccountId: null }] }) } as unknown as ProviderSettingsStoreWriter;
  const [adapter] = await createNativeProviderWorkflowAdapters({ store, terminal, hostControl: { available: false, run: vi.fn() } });
  const operation = await adapter!.start({ registerCleanup: () => {},  request: { harnessInstanceId: 'codex', kind: 'uninstall', idempotencyKey: 'safe-uninstall' }, publish: vi.fn() });
  expect(createTab.mock.calls[0]![1].command).toEqual(['sh', '-lc', "'/opt/matrix/runtime/node/bin/npm' uninstall -g --prefix '/opt/matrix/runtime/node' --ignore-scripts '@openai/codex'"]);
  await operation.cancel();
});
