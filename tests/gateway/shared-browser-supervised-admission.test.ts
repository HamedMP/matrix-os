import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";
import { openNativeSharedBrowserRun } from "../../packages/gateway/src/chat/native-shared-browser-run.js";

const brokers: ReturnType<typeof createSharedBrowserBroker>[] = [];
afterEach(async () => { await Promise.all(brokers.splice(0).map(broker => broker.close())); });

describe("supervised native shared Chrome discovery", () => {
  it.each(["codex", "claude_code"] as const)("exposes %s's fixed tool without executing a browser action", async harness => {
    const driver = { execute: vi.fn(async () => ({ success: true })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
    const broker = createSharedBrowserBroker({ ownerId: "owner_browser", driver, setHumanControl: async () => {} });
    brokers.push(broker);
    const run = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, {
      owner: { type: "personal", ownerId: "owner_browser" }, chatId: "chat_browser", runId: `run_${harness}`,
      permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal,
    });

    expect(run, "Supervised Chat must discover the shared Chrome tool instead of receiving no browser capability").toBeDefined();
    expect(run!.mcpServer.args).toEqual(["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"]);
    expect(driver.execute).not.toHaveBeenCalled();
    expect(broker.status().phase).toBe("idle");
    await run!.close();
  });
});

it.each(["codex", "claude_code"] as const)("missing %s approval authority denies only the action without disabling Chrome", async harness => {
  const driver = { execute: vi.fn(async () => ({ success: true })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
  const broker = createSharedBrowserBroker({ ownerId: "owner_browser", driver, setHumanControl: async () => {} }); brokers.push(broker);
  const input = { owner: { type: "personal", ownerId: "owner_browser" }, chatId: "chat_browser", runId: `run_missing_${harness}`,
    permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  const lease = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, input)!;
  await expect(broker.execute(broker.resolveCapability(lease.token)!, { action: "snapshot" }, input.signal)).rejects.toHaveProperty("code", "browser_changed");
  expect(driver.execute).not.toHaveBeenCalled(); expect(broker.status().phase).toBe("agent");
  await lease.close();
  const next = broker.openRun({ ownerId: "owner_browser", chatId: "chat_next", runId: "run_next", harness }, input.signal);
  await expect(broker.execute(broker.resolveCapability(next.token)!, { action: "snapshot" }, input.signal)).resolves.toMatchObject({ success: true });
});

it.each(["codex", "claude_code"] as const)("keeps %s's scoped tool undiscoverable in other Chats and past cutoff", async harness => {
  let now = 1000;
  const driver = { execute: vi.fn(async () => ({ success: true })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
  const authorize = vi.fn(async () => {});
  const broker = createSharedBrowserBroker({ ownerId: "owner_browser", driver, setHumanControl: async () => {}, now: () => now,
    authorizeAction: authorize, supervisedRunExpiresAt: binding => binding.chatId === "chat_browser" ? 2000 : 0 });
  brokers.push(broker);
  const input = { owner: { type: "personal", ownerId: "owner_browser" }, chatId: "chat_browser", runId: "run_scoped",
    permissionMode: "supervised", interactionMode: "default", signal: new AbortController().signal };
  expect(Boolean(openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, { ...input, chatId: "chat_other" }))).toBe(false);
  const lease = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, input)!;
  expect(lease.expiresAt).toBe(2000);
  const binding = broker.resolveCapability(lease.token)!;
  authorize.mockImplementationOnce(async () => { now = 2000; });
  await expect(broker.execute(binding, { action: "snapshot" }, input.signal)).rejects.toThrow();
  expect(driver.execute).not.toHaveBeenCalled();
  expect(broker.resolveCapability(lease.token)).toBeNull();
  expect(Boolean(openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, { ...input, runId: "run_expired" }))).toBe(false);
  const full = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness }, { ...input, chatId: "chat_other", runId: "run_full", permissionMode: "full_access" });
  expect(full).toBeDefined();
});

it("expires a scoped lease and releases human control while approval is still pending", async () => {
  vi.useFakeTimers();
  try {
    const driver = { execute: vi.fn(async () => ({ success: true })), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}) };
    const setHumanControl = vi.fn(async () => {});
    const authorize = vi.fn(() => new Promise<void>(() => {}));
    const expiresAt = Date.now() + 1000;
    const broker = createSharedBrowserBroker({ ownerId: "owner_browser", driver, setHumanControl,
      authorizeAction: authorize, supervisedRunExpiresAt: () => expiresAt });
    brokers.push(broker);
    const signal = new AbortController().signal;
    const lease = openNativeSharedBrowserRun({ broker, gatewayPort: 4000, harness: "codex" }, {
      owner: { type: "personal", ownerId: "owner_browser" }, chatId: "chat_browser", runId: "run_wait",
      permissionMode: "supervised", interactionMode: "default", signal,
    })!;
    const pending = broker.execute(broker.resolveCapability(lease.token)!, { action: "snapshot" }, signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(authorize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBeInstanceOf(Error);
    await lease.close();
    expect(driver.execute).not.toHaveBeenCalled();
    expect(driver.detach).toHaveBeenCalledOnce();
    expect(setHumanControl).toHaveBeenLastCalledWith(true);
  } finally {
    vi.useRealTimers();
  }
});
