import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as broker from "../../packages/gateway/src/bots/broker-actions.js";
import * as googleRuntime from "../../packages/gateway/src/startup/google-data.js";
import { startBots } from "../../packages/gateway/src/startup/bots.js";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createBotStateDatabase } from "./bots/bot-state-support.js";
import { createExecutionAdmissionFence } from "../../packages/gateway/src/execution-admission-fence.js";

const cleanup: Array<() => Promise<unknown>> = []; // Fixture-owned; drained after each test.
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function setup() {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-analytics-startup-"));
  cleanup.push(() => rm(homePath, { recursive: true, force: true }));
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = new ChatAgentStore({ homePath, db: repository.kysely }); await agents.bootstrap(); cleanup.push(() => agents.close());
  const analytics = { capture: vi.fn(async () => null), completed: vi.fn(), cancel: vi.fn(),
    close: vi.fn(async () => ({ drained: true })), deleteOwner: vi.fn(), deleteChat: vi.fn(), whenIdle: vi.fn() };
  const registered = vi.spyOn(broker, "createBotBrokerActions");
  const unregister = vi.fn();
  const options = { homePath, repository, agents, chatAnalytics: analytics,
    executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: vi.fn() },
    host: { available: true, client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() },
      registerAuthorizer: vi.fn(() => unregister) } as never,
  };
  return { options, analytics, registered, unregister };
}

describe("ordinary Chat analytics production startup composition", () => {
  it.each(["pilot", "funded-owner"])("awaits transferred analytics cleanup when %s preflight rejects", async invalid => {
    const f = await setup(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.analytics.close.mockImplementation(async () => { await held; return { drained: true }; });
    let settled = false;
    const starting = startBots({ ...f.options, runtimeOwnerId: "owner_one",
      googlePilot: { enabled: true, ownerId: invalid === "pilot" ? "wrong_owner" : "owner_one" },
      googleCopies: {} as never, executionAdmissionFence: createExecutionAdmissionFence(),
      pendingExecutionCount: () => 0, integrations: vi.fn() as never,
      ...(invalid === "funded-owner" ? { qualifiedFundedConfig: { identity: { ownerId: "wrong_owner" } } as never } : {}),
    }).finally(() => { settled = true; });
    const rejection = expect(starting).rejects.toThrow("Google pilot unavailable");
    try {
      await vi.waitFor(() => expect(f.analytics.close).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
    } finally { release(); await rejection; }
    expect(settled).toBe(true);
  });

  it("installs the same private analytics hooks in the actual shared bot/managed inference broker", async () => {
    const f = await setup(); const services = await startBots(f.options); cleanup.push(() => services!.close());
    expect(services?.adapter).toBeTruthy(); expect(services?.managedAdapter).toBeTruthy();
    expect(f.registered).toHaveBeenCalledOnce();
    expect(f.registered.mock.calls[0]![0].inference).toHaveProperty("chatAnalytics", f.analytics);
  });

  it("awaits the transferred analytics runtime drain before services report closed", async () => {
    const f = await setup(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    f.analytics.close.mockImplementation(async () => { await held; return { drained: true }; });
    const services = await startBots(f.options); let closed = false;
    const closing = services!.close().then(() => { closed = true; });
    try {
      await vi.waitFor(() => expect(f.analytics.close).toHaveBeenCalledOnce()); expect(closed).toBe(false);
    } finally { release(); await closing; }
    expect(closed).toBe(true); expect(f.unregister).toHaveBeenCalledTimes(1);
  });

  it("does not claim successful shutdown when classifier work has not actually drained", async () => {
    const f = await setup(); f.analytics.close.mockResolvedValue({ drained: false });
    const services = await startBots(f.options);
    await expect(services!.close()).rejects.toThrow();
    expect(f.analytics.close).toHaveBeenCalledOnce();
  });

  it("drains the acquired analytics runtime if later broker startup fails", async () => {
    const f = await setup(); vi.spyOn(googleRuntime, "createGoogleBrokerRuntime").mockRejectedValue(new Error("Fixture failure"));
    await expect(startBots(f.options)).rejects.toThrow("Fixture failure");
    expect(f.analytics.close).toHaveBeenCalledOnce();
  });
});
