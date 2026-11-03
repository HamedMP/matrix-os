import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalRuntime } from '../../packages/terminal-runtime/src/runtime.js';
import { TerminalWorkspaceStore } from '../../packages/terminal-runtime/src/workspace-store.js';
import { TerminalRuntimeSocketServer } from '../../packages/terminal-runtime/src/socket-server.js';
import { TerminalRuntimeSocketClient, type TerminalRuntimeSocketStream } from '../../packages/terminal-runtime/src/socket-client.js';
import { createNativeProviderWorkflowAdapters } from '../../packages/gateway/src/ai-providers/provider-workflow-native.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.useRealTimers(); } });
const nativeImmediate = globalThis.setImmediate;
const flushSocket = () => new Promise<void>(resolve => nativeImmediate(resolve));

async function fixture(initial: { state?: 'running' | 'exited' | 'unknown'; exitCode?: number; rejectedIdentity?: boolean; socket?: boolean } = {}) {
  const home = await mkdtemp(initial.socket ? '/tmp/native-command-lease-' : join(tmpdir(), 'native-command-result-'));
  let attachmentInput: { onData(data: Uint8Array): void; onExit(code: number | null): void } | undefined;
  const result = { state: initial.state ?? 'exited', exitCode: initial.exitCode ?? 0 };
  const zellij = {
    ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => ({ tabId: 1, paneId: 'terminal_1' })),
    subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })),
    getCommandState: vi.fn(async () => result.state),
    getCommandResult: vi.fn(async () => result.state === 'exited' ? { ...result } : { state: result.state }),
    openAttachment: vi.fn(async (_name: string, input: NonNullable<typeof attachmentInput>) => {
      attachmentInput = input; return { write: async () => {}, resize: async () => {}, close: async () => {} };
    }),
    closeTab: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}),
    resizeSession: vi.fn(async () => {}),
  };
  const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath: home }), zellij });
  let server: TerminalRuntimeSocketServer | undefined;
  const cleanup: Array<() => Promise<void>> = [];
  cleanups.push(async () => { for (const release of cleanup) await release(); await server?.close(); await runtime.shutdown(); await rm(home, { recursive: true, force: true }); });
  const workspace = await runtime.ensureWorkspace();
  const tab = await runtime.createTab(workspace.id, { name: 'synthetic-login', cwd: '', command: ['/fake/codex', 'login', '--device-auth'] });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  const row = { id: 'harness_codex', harness: 'codex', displayName: 'Codex', installState: 'installed', loginMethods: ['terminal'], route: { kind: 'fixed', providerId: 'openai', modelId: 'synthetic-model' } };
  const snapshot = { revision: 0, access: { mode: 'writable' }, harnessCatalog: [], harnesses: [row] };
  const complete = vi.fn(async () => { if (initial.rejectedIdentity) throw new Error('synthetic identity mismatch'); });
  const store = { getSnapshot: vi.fn(async () => snapshot), completeCodexNativeLogin: complete,
    mutate: vi.fn(async () => ({ kind: 'login_attempt', snapshot, attempt: { action: { kind: 'open_terminal', terminalSessionId: `${ref.workspaceId}:${ref.tabId}` } } })) };
  let attached: Promise<Awaited<ReturnType<TerminalRuntime['attach']>>> | undefined;
  type AttachInput = Parameters<import('../../packages/terminal-runtime/src/socket-client.js').TerminalRuntimeSocketClient['attach']>[0];
  let transportInput: AttachInput;
  const mockedTerminal = {
    listWorkspaces: () => runtime.listWorkspaces(), ensureWorkspace: () => runtime.ensureWorkspace(), createTab: vi.fn(),
    getCommandResult: vi.fn((target, incarnation) => runtime.getCommandResult(target, incarnation)),
    terminateTab: vi.fn((target, incarnation) => runtime.terminateTab(target, incarnation)),
    attach: (input: AttachInput) => {
      transportInput = input;
      attached = runtime.attach(input.ref, { viewerId: input.viewerId, expectedIncarnation: input.expectedIncarnation,
        send: data => input.onFrame({ type: 'output', data: new TextDecoder().decode(data), terminalRef: ref, revision: 1 }),
        onExit: exitCode => input.onFrame({ type: 'exit', exitCode, terminalRef: ref, revision: 2 }) });
      return { close: () => { void attached?.then(viewer => viewer.detach()); }, send: vi.fn() };
    },
  };
  let lastRead: Promise<unknown> | undefined;
  let socketStream: TerminalRuntimeSocketStream | undefined;
  const socketFrames = vi.fn();
  let socketReady: Promise<void> | undefined;
  let terminal: typeof mockedTerminal | TerminalRuntimeSocketClient = mockedTerminal;
  if (initial.socket) {
    const socketPath = join(home, 't.sock');
    server = new TerminalRuntimeSocketServer({ socketPath, runtime });
    await server.start();
    const client = new TerminalRuntimeSocketClient({ socketPath });
    const read = client.getCommandResult.bind(client);
    vi.spyOn(client, 'getCommandResult').mockImplementation((...args) => { lastRead = read(...args); return lastRead as ReturnType<typeof read>; });
    const attach = client.attach.bind(client);
    socketReady = new Promise<void>(resolve => {
      vi.spyOn(client, 'attach').mockImplementation(input => {
        socketStream = attach({ ...input, onFrame(frame) {
          socketFrames(frame);
          input.onFrame(frame);
          if (frame.type === 'replay-end') resolve();
        } });
        vi.spyOn(socketStream, 'send');
        return socketStream;
      });
    });
    terminal = client;
  }
  const [adapter] = await createNativeProviderWorkflowAdapters({ store, terminal, hostControl: { available: false, run: vi.fn() } } as never);
  const publish = vi.fn();
  const running = await adapter!.start({ request: { harnessInstanceId: row.id, kind: 'login', method: 'terminal', idempotencyKey: 'synthetic-receipt' }, publish,
    registerCleanup: release => { cleanup[0] = release; } });
  cleanup[0] = running.cancel;
  await attached;
  await socketReady;
  return { result, complete, store, terminal, publish, runtime, ref, tab, snapshot, cleanup, socketFrames,
    socketStream, readDone: () => lastRead,
    transportClose: () => transportInput.onClose?.(),
    output: (text: string) => attachmentInput!.onData(new TextEncoder().encode(text)), attachmentExit: (code: number) => attachmentInput!.onExit(code) };
}

it('keeps a quiet Codex login alive past the real runtime viewer TTL, then completes and releases its heartbeat', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = await fixture({ state: 'running', socket: true });
  const startTime = Date.now();
  // Keep the real runtime, its default two-minute viewer TTL, socket framing,
  // ping validation and viewer.touch path. Only the native CLI/process is fake.
  for (let second = 0; second < 180; second += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    await f.readDone();
    await flushSocket();
  }
  expect(Date.now() - startTime).toBe(180_000);
  // Admission also runs the production stale-viewer sweep synchronously.
  const otherViewer = await f.runtime.attach(f.ref, { viewerId: 'independent-reader', expectedIncarnation: f.tab.incarnation,
    send() {}, onExit() {} });
  f.cleanup.push(() => otherViewer.detach());
  for (let turn = 0; turn < 8; turn += 1) await flushSocket();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
  expect(await f.runtime.getCommandState(f.ref, f.tab.incarnation)).toBe('running');
  expect(f.socketFrames).toHaveBeenCalledWith(expect.objectContaining({ type: 'pong', terminalRef: f.ref }));
  expect(f.complete).not.toHaveBeenCalled();
  f.result.state = 'exited';
  await vi.advanceTimersByTimeAsync(1000);
  await f.readDone();
  for (let turn = 0; turn < 8; turn += 1) await flushSocket();
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null });
  const sent = vi.mocked(f.socketStream!.send).mock.calls.length;
  await vi.advanceTimersByTimeAsync(180_000);
  await flushSocket();
  expect(f.socketStream!.send).toHaveBeenCalledTimes(sent);
}, 15_000);

it('releases the real socket heartbeat on cancellation without accepting a later exit0', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const f = await fixture({ state: 'running', socket: true });
  await vi.advanceTimersByTimeAsync(1000);
  await f.readDone();
  await flushSocket();
  expect(f.socketStream!.send).toHaveBeenCalledWith({ type: 'ping', terminalRef: f.ref });
  await f.cleanup[0]!();
  const sent = vi.mocked(f.socketStream!.send).mock.calls.length;
  f.result.state = 'exited';
  await vi.advanceTimersByTimeAsync(180_000);
  await flushSocket();
  expect(f.socketStream!.send).toHaveBeenCalledTimes(sent);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
});

it('completes an exact successful inner login while the actual runtime attachment stays open', async () => {
  const f = await fixture();
  f.output('Successfully logged in\n');
  expect(await f.runtime.getCommandState(f.ref, f.tab.incarnation)).toBe('exited');
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce(), { timeout: 1800 });
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0, harnessInstanceId: 'harness_codex' }));
  expect(f.terminal.terminateTab).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'succeeded', safeFailure: null }));
});
it('rejects an actual nonzero command result without calling native identity completion', async () => {
  const f = await fixture({ exitCode: 9 });
  f.output('Successfully logged in\n');
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'rejected' }));
  expect(f.complete).not.toHaveBeenCalled();
});
it('does not borrow exit0 from the attachment while command result is unknown, then recovers on exact result', async () => {
  const f = await fixture({ state: 'unknown' });
  f.attachmentExit(0);
  await vi.waitFor(() => expect(f.terminal.getCommandResult).toHaveBeenCalled());
  expect(f.complete).not.toHaveBeenCalled();
  f.result.state = 'exited';
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledOnce(), { timeout: 1800 });
});
it('retains fresh identity verification after command exit0', async () => {
  const f = await fixture({ rejectedIdentity: true });
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
});
it('does not complete a different source or revision after the original foreground receipt', async () => {
  const f = await fixture({ state: 'unknown' });
  f.snapshot.revision += 1; f.result.state = 'exited';
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }), { timeout: 1800 });
  expect(f.complete).not.toHaveBeenCalled();
});
it('cancellation stops observation without manufacturing a successful completion', async () => {
  const f = await fixture({ state: 'unknown' });
  await f.cleanup[0]!(); f.result.state = 'exited';
  expect(f.terminal.terminateTab).toHaveBeenCalledWith(f.ref, f.tab.incarnation);
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
});
it('does not invoke private completion if cancellation arrives during the fresh account read', async () => {
  const f = await fixture({ state: 'unknown' });
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.store.getSnapshot.mockImplementationOnce(async () => { entered(); await gate; return f.snapshot; });
  f.result.state = 'exited';
  await waiting;
  const cancelled = f.cleanup[0]!(); release(); await cancelled;
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded' }));
});
it('discards inner exit0 racing with attachment close without double settlement', async () => {
  const f = await fixture({ state: 'unknown' });
  let release!: (value: { state: 'exited'; exitCode: number }) => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<{ state: 'exited'; exitCode: number }>(resolve => { release = resolve; });
  f.terminal.getCommandResult.mockImplementationOnce(() => { entered(); return gate; });
  await pending;
  release({ state: 'exited', exitCode: 0 }); f.transportClose();
  await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'failed', safeFailure: 'unavailable' }));
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.terminal.terminateTab).toHaveBeenCalledOnce();
  expect(f.publish.mock.calls.filter(([value]) => value.state === 'failed')).toHaveLength(1);
});
it('does not revive completion when cancelled command cleanup fails and is retried', async () => {
  const f = await fixture({ state: 'unknown' });
  f.terminal.terminateTab.mockRejectedValueOnce(new Error('synthetic cleanup failure'));
  await expect(f.cleanup[0]!()).rejects.toMatchObject({ code: 'unavailable' });
  f.result.state = 'exited'; f.attachmentExit(0);
  await f.cleanup[0]!();
  expect(f.terminal.terminateTab).toHaveBeenCalledTimes(2);
  expect(f.complete).not.toHaveBeenCalled();
});
it('expires an unknown inner result without interpreting a later success as consent', async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture({ state: 'unknown' });
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledWith({ state: 'expired', safeFailure: 'expired' }));
    f.result.state = 'exited';
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.complete).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
