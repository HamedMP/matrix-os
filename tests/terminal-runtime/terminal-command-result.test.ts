import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ZellijCliRuntimeAdapter } from '../../packages/terminal-runtime/src/zellij-adapter.js';
import { TerminalRuntime, type ZellijRuntimeAdapter } from '../../packages/terminal-runtime/src/runtime.js';
import { TerminalWorkspaceStore } from '../../packages/terminal-runtime/src/workspace-store.js';
import { TerminalRuntimeSocketClient } from '../../packages/terminal-runtime/src/socket-client.js';
import { TerminalRuntimeSocketServer } from '../../packages/terminal-runtime/src/socket-server.js';
import { TerminalRuntimeRequestSchema } from '../../packages/terminal-runtime/src/socket-protocol.js';
import { createUnixSocketTempDir } from '../helpers/unix-socket-temp.js';
const SESSION = 'matrix-w-00000000000000000000000000000001';
const pane = { id: 2, tab_id: 3, is_plugin: false, is_held: false, exit_status: null };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it.each([0, 1, 127, 255])('reads actual exit %s only from the exact held pane', async exitCode => {
  const run = vi.fn(async () => JSON.stringify([{ ...pane, is_held: true, exit_status: exitCode }]));
  const adapter = new ZellijCliRuntimeAdapter({ homePath: '/synthetic-owner', run });
  await expect(adapter.getCommandResult(SESSION, 3, 'terminal_2')).resolves.toEqual({ state: 'exited', exitCode });
});
it.each([
  [pane, { state: 'running' }],
  [{ ...pane, is_held: true }, { state: 'unknown' }],
  [{ ...pane, is_held: true, exit_status: -1 }, { state: 'unknown' }],
  [{ ...pane, is_held: true, exit_status: 256 }, { state: 'unknown' }],
  [{ ...pane, is_held: true, exit_status: '0' }, { state: 'unknown' }],
  [{ ...pane, is_held: false, exit_status: 0 }, { state: 'unknown' }],
  [{ ...pane, tab_id: 4, is_held: true, exit_status: 0 }, { state: 'unknown' }],
])('never converts uncertain or unrelated pane evidence %j into exit0', async (observed, expected) => {
  const adapter = new ZellijCliRuntimeAdapter({ homePath: '/synthetic-owner', run: vi.fn(async () => JSON.stringify([observed])) });
  await expect(adapter.getCommandResult(SESSION, 3, 'terminal_2')).resolves.toEqual(expected);
});
async function harness() {
  const home = await createUnixSocketTempDir(); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new TerminalWorkspaceStore({ homePath: home });
  const workspace = await store.ensureWorkspace();
  const tab = await store.createTab(workspace.id, { name: 'synthetic-login', cwd: '' });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  const active = await store.activateTab(ref, { tabId: 3, paneId: 'terminal_2' });
  const getCommandResult = vi.fn(async () => ({ state: 'exited', exitCode: 0 }));
  const adapter = { getCommandResult } as unknown as ZellijRuntimeAdapter;
  const runtime = new TerminalRuntime({ store, zellij: adapter }); cleanup.push(() => runtime.shutdown());
  return { home, store, ref, active, getCommandResult, adapter, runtime };
}
it('binds actual result to current incarnation and rejects replacement during the read', async () => {
  const h = await harness();
  await expect(h.runtime.getCommandResult(h.ref, h.active.incarnation)).resolves.toEqual({ state: 'exited', exitCode: 0 });
  await expect(h.runtime.getCommandResult(h.ref, 'ti_00000000000000000000000000000001')).resolves.toEqual({ state: 'unknown' });
  expect(h.getCommandResult).toHaveBeenCalledOnce();
  h.getCommandResult.mockImplementationOnce(async () => {
    await h.store.activateTab(h.ref, { tabId: 9, paneId: 'terminal_9' }); return { state: 'exited', exitCode: 0 };
  });
  await expect(h.runtime.getCommandResult(h.ref, h.active.incarnation)).resolves.toEqual({ state: 'unknown' });
});
it('round-trips only validated result through the owner Unix socket, requiring an incarnation', async () => {
  const h = await harness(); const socketPath = join(h.home, 'result.sock');
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime: h.runtime });
  await server.start(); cleanup.push(() => server.close());
  const client = new TerminalRuntimeSocketClient({ socketPath });
  await expect(client.getCommandResult(h.ref, h.active.incarnation)).resolves.toEqual({ state: 'exited', exitCode: 0 });
  h.getCommandResult.mockResolvedValueOnce({ state: 'exited' } as never);
  await expect(client.getCommandResult(h.ref, h.active.incarnation)).resolves.toEqual({ state: 'unknown' });
  const request = { version: 1, requestId: 'req_00000000000000000000000000000001', operation: 'GetCommandResult', input: { ...h.ref, expectedIncarnation: h.active.incarnation } };
  expect(TerminalRuntimeRequestSchema.safeParse(request).success).toBe(true);
  expect(TerminalRuntimeRequestSchema.safeParse({ ...request, input: h.ref }).success).toBe(false);
});
