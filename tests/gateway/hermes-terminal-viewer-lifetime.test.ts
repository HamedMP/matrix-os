import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createUnixSocketTempDir } from '../helpers/unix-socket-temp.js';
import { TerminalRuntime } from '../../packages/terminal-runtime/src/runtime.js';
import { TerminalWorkspaceStore } from '../../packages/terminal-runtime/src/workspace-store.js';
import { TerminalRuntimeSocketClient } from '../../packages/terminal-runtime/src/socket-client.js';
import { TerminalRuntimeSocketServer } from '../../packages/terminal-runtime/src/socket-server.js';
import { createHermesTerminalWorkflow } from '../../packages/gateway/src/ai-providers/hermes-terminal-workflow.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
 vi.useRealTimers();
 for (const close of cleanups.splice(0).reverse()) await close();
});

// Detects the live regression: the workflow's idle output viewer expires at the
// real runtime's two-minute TTL and kills a still-pending ten-minute OAuth command.
// Runtime, durable store, socket protocol and workflow are real; Zellij and
// provider identity completion are isolated, with no credentials or network.
it('completes the exact Hermes login after a stale output viewer is reclaimed', async () => {
 vi.useFakeTimers({ toFake: ['Date'] });
 const home = await createUnixSocketTempDir();
 cleanups.push(() => rm(home, { recursive: true, force: true }));
 let exited = false;
 const zellij = {
  ensureSession: async () => {},
  createTab: async () => ({ tabId: 1, paneId: 'terminal_1' }),
  subscribeWorkspace: async () => ({ close: async () => {} }),
  getCommandResult: vi.fn(async () => exited ? { state: 'exited' as const, exitCode: 0 } : { state: 'running' as const }),
  openAttachment: async () => ({ write: async () => {}, resize: async () => {}, close: async () => {} }),
  closeTab: vi.fn(async () => {}),
 };
 const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath: home }), zellij });
 cleanups.push(() => runtime.shutdown());
 const server = new TerminalRuntimeSocketServer({ socketPath: join(home, 'runtime.sock'), runtime });
 await server.start();
 cleanups.push(() => server.close());
 const terminal = new TerminalRuntimeSocketClient({ socketPath: join(home, 'runtime.sock') });
 const complete = vi.fn(async () => {}), publish = vi.fn(), release = vi.fn(async () => {});
 const start = createHermesTerminalWorkflow({ harnessInstanceId: 'harness_hermes', terminal,
  runtime: { prepare: async () => ({ command: ['/synthetic/hermes', 'auth', 'add'], cwd: '' }), complete },
  writer: { acquire: async () => release } as never,
  store: { getSnapshot: async () => ({ revision: 7, access: { mode: 'writable' }, harnesses: [{ id: 'harness_hermes', harness: 'hermes', installState: 'installed' }] }) } as never,
 });
 const workflow = await start({ request: { harnessInstanceId: 'harness_hermes', kind: 'login', method: 'terminal', idempotencyKey: 'viewer-lifetime' },
  connectionOption: { id: 'openai_terminal', providerId: 'openai', method: 'terminal', authKind: 'subscription', billingKind: 'subscription', executionKind: 'native', availability: 'available' },
  publish, registerCleanup: () => {},
 });
 cleanups.push(workflow.cancel);
 const [workspace] = await runtime.listWorkspaces();
 const [tab] = workspace!.tabs;
 const ref = { workspaceId: workspace!.id, tabId: tab!.id };
 await vi.waitFor(() => expect(zellij.getCommandResult.mock.calls.length).toBeGreaterThan(1), { timeout: 1800 });
 const disconnected = vi.fn();
 const viewer = await runtime.attach(ref, { viewerId: 'isolated-ui-before-wait', expectedIncarnation: tab!.incarnation, mode: 'soft', size: { cols: 100, rows: 30 }, send: () => {}, onDisconnect: disconnected });
 cleanups.push(() => viewer.detach());
 vi.setSystemTime(Date.now() + 125_000);
 // Public attachment admission executes the real stale-viewer sweep. No private
 // method, copied TTL policy, altered security configuration or timer shortcut.
 const nextViewer = await runtime.attach(ref, { viewerId: 'isolated-ui-after-wait', expectedIncarnation: tab!.incarnation, mode: 'soft', size: { cols: 100, rows: 30 }, send: () => {} });
 cleanups.push(() => nextViewer.detach());
 expect(disconnected).toHaveBeenCalledOnce();
 exited = true;
 await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }), { timeout: 1800 });
 expect(complete).toHaveBeenCalledWith('harness_hermes', 'openai-codex', 7, 'viewer-lifetime', expect.any(AbortSignal));
 expect(zellij.closeTab).not.toHaveBeenCalled();
 expect(release).toHaveBeenCalledOnce();
});
