import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexSettingsLogin } from "../../packages/gateway/src/ai-providers/provider-workflow-codex-login.js";
import { createNativeProviderWorkflowAdapters } from "../../packages/gateway/src/ai-providers/provider-workflow-native.js";
import type { ProviderSettingsStoreWriter } from "../../packages/gateway/src/ai-providers/provider-settings-store.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => vi.restoreAllMocks());

function barrier() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}
async function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
  const snapshot = { revision: 0, access: { mode: "writable" }, harnesses: [{
    id: "harness_codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["terminal"],
  }] };
  const getSnapshot = vi.fn(async () => snapshot);
  const complete = vi.fn(async () => ({ kind: "snapshot", snapshot }));
  const mutate = vi.fn(), releaseProfile = vi.fn(), proof = vi.fn(async () => true);
  const start = createCodexSettingsLogin({ command: "fake-codex", cwd: "/fake", env: {},
    acquire: async () => releaseProfile, captureAccountProof: async () => proof });
  const [adapter] = await createNativeProviderWorkflowAdapters({
    store: { getSnapshot, mutate, completeCodexNativeLogin: complete } as unknown as ProviderSettingsStoreWriter,
    terminal: {} as never, hostControl: { available: false, run: vi.fn() },
    codexSettingsConnection: { available: async () => true, start },
  });
  const publish = vi.fn();
  const running = await adapter!.start({ request: {
    harnessInstanceId: "harness_codex", kind: "login", method: "device_code", idempotencyKey: "device-cancel-race",
  }, publish, registerCleanup: vi.fn() });
  const loginId = "11111111-1111-4111-8111-111111111111";
  const respond = (message: unknown) => child.stdout.emit("data", JSON.stringify(message) + "\n");
  const authenticate = () => {
    respond({ id: 4, result: { account: null } });
    respond({ id: 2, result: { type: "chatgptDeviceCode", loginId,
      verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" } });
    respond({ method: "account/login/completed", params: { loginId, success: true } });
    child.emit("close", 0);
  };
  return { getSnapshot, complete, mutate, snapshot, publish, running, authenticate, releaseProfile, proof };
}

it("does not connect or enable Codex when cancellation wins during the fresh account read", async () => {
  const f = await fixture();
  const entered = barrier(), read = barrier();
  f.getSnapshot.mockImplementationOnce(async () => { entered.release(); await read.waiting; return f.snapshot; });
  f.authenticate();
  await entered.waiting;
  const cancelled = f.running.cancel();
  read.release();
  await cancelled;
  expect(f.complete).not.toHaveBeenCalled();
  expect(f.mutate).not.toHaveBeenCalled();
  expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
  expect(f.releaseProfile).toHaveBeenCalledOnce();
});

it.each([true, false])("waits for private completion already dispatched and reports its real result (success: %s)", async success => {
  const f = await fixture();
  const entered = barrier(), commit = barrier();
  f.complete.mockImplementationOnce(async () => {
    entered.release(); await commit.waiting;
    if (!success) throw new Error("synthetic completion rejected");
    return { kind: "snapshot", snapshot: f.snapshot };
  });
  f.authenticate();
  await entered.waiting;
  let cancellationSettled = false;
  const cancelled = f.running.cancel().then(() => { cancellationSettled = true; });
  await Promise.resolve();
  expect(cancellationSettled).toBe(false);
  commit.release();
  await cancelled;
  expect(f.complete).toHaveBeenCalledOnce();
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({
    harnessInstanceId: "harness_codex", expectedRevision: 0, verifyNativeAccount: f.proof,
  }));
  if (success) expect(f.publish).toHaveBeenCalledWith({ state: "succeeded", safeFailure: null });
  else expect(f.publish).not.toHaveBeenCalledWith(expect.objectContaining({ state: "succeeded" }));
  expect(f.releaseProfile).toHaveBeenCalledOnce();
});
