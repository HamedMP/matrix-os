import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { BotRunSpec, BotToolRequest } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BotBrokerActionError, createBotBrokerActions, type BotToolDispatcher } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotCheckpointsRepository, type BotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import type { FundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const RUNTIME = `runtime_${"e".repeat(32)}`;
const REQUEST_ID = "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1";
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let binding: BotRuntimeBinding;

const spec: BotRunSpec = {
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4_096 },
  systemPrompt: "You are Research Rabbit.",
  capabilities: ["artifact.write"],
  limits: { maxToolActions: 20 },
  turn: { kind: "prompt", text: "Write the brief." },
};

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_direct1");
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_direct1", now: NOW });
  binding = {
    runtimeHandle: RUNTIME, executionGeneration: "6", ownerId: OWNER, botId: BOT, chatId: "chat_direct1",
    taskId: task.taskId, runId: "run_broker1", rootFingerprint: "f".repeat(64), route: spec.route,
    accessSourceId: "matrix_included", capabilities: ["artifact.write", "artifact.read"], requestClass: "interactive",
  };
});
afterEach(async () => destroy());

function setup(overrides: {
  maxTrackedRuns?: number;
  tools?: Partial<BotToolDispatcher>;
  fetchImpl?: typeof fetch;
  toolTimeoutMs?: number;
  checkpoints?: (repository: BotCheckpointsRepository, registry: BotRuntimeRegistry) => BotCheckpointsRepository;
  resolveCredentials?: (registry: BotRuntimeRegistry) => unknown;
  fundedAdmission?: FundedAdmissionQueue;
  publish?: () => Promise<void>;
  revalidateBinding?: () => Promise<boolean>;
} = {}) {
  const registry = new BotRuntimeRegistry();
  registry.bind(binding);
  const events = { publish: vi.fn(overrides.publish ?? (async () => undefined)) };
  const tools: BotToolDispatcher = {
    effectClass: () => "write",
    dispatch: vi.fn(async () => ({ result: { ok: true as const, content: [{ type: "text" as const, text: "saved" }] }, outcomeRef: "artifact_1" })),
    ...overrides.tools,
  };
  const lifetime = new AbortController();
  const checkpoints = createBotCheckpointsRepository(db);
  const actions = createBotBrokerActions({
    db,
    registry,
    sessions: createBotSessionsRepository(db),
    checkpoints: overrides.checkpoints ? overrides.checkpoints(checkpoints, registry) : checkpoints,
    runs: {
      loadRunSpec: vi.fn(async () => spec),
      readImageChunk: vi.fn(async () => ({ mimeType: "image/png" as const, totalChars: 4, data: "AAAA" })),
    },
    events,
    tools,
    inference: {
      homePath: "/tmp",
      lifetime: lifetime.signal,
      fundedAdmission: overrides.fundedAdmission,
      revalidateBinding: overrides.revalidateBinding,
      resolveCredentials: (overrides.resolveCredentials
        ? overrides.resolveCredentials(registry)
        : vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "funded-token", ANTHROPIC_BASE_URL: "https://relay.test" } }))) as never,
      fetchImpl: overrides.fetchImpl ?? (vi.fn(async () => new Response("event: done\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })) as never),
    },
    now: () => new Date(NOW),
    ...(overrides.toolTimeoutMs ? { toolTimeoutMs: overrides.toolTimeoutMs } : {}),
    ...(overrides.maxTrackedRuns ? { maxTrackedRuns: overrides.maxTrackedRuns } : {}),
  });
  return { actions, registry, events, tools, lifetime };
}

const frame = (action: Record<string, unknown>) => ({
  version: 1, requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "6", runId: "run_broker1", ...action,
});
const tool = (overrides: Partial<BotToolRequest> = {}) => frame({
  action: "bot.tool",
  tool: { toolCallId: "call_1", capability: "artifact.write", args: { relPath: "briefs/acme.md", content: "# Acme", mimeType: "text/markdown" }, ...overrides },
});

describe("bot broker actions", () => {
  it("refuses frames for another runtime, generation, or run as stale", async () => {
    const { actions } = setup();
    for (const stale of [
      frame({ action: "bot.session.load", executionGeneration: "5" }),
      frame({ action: "bot.session.load", runId: "run_other" }),
      frame({ action: "bot.session.load", runtimeHandle: `runtime_${"9".repeat(32)}` }),
    ]) {
      await expect(actions.handleFrame(stale)).resolves.toEqual({ version: 1, requestId: REQUEST_ID, ok: false, code: "stale_generation" });
    }
    await expect(actions.handleFrame({ action: "bot.session.load" })).resolves.toBeUndefined();
  });

  it("loads the admitted run and images, and saves the session at its revision", async () => {
    const { actions } = setup();
    await expect(actions.handleFrame(frame({ action: "bot.run.load" }))).resolves.toMatchObject({ ok: true, result: spec });
    await expect(actions.handleFrame(frame({ action: "bot.input.image", image: { index: 0, offset: 0 } })))
      .resolves.toMatchObject({ ok: true, result: { mimeType: "image/png", data: "AAAA" } });
    await expect(actions.handleFrame(frame({ action: "bot.session.load" }))).resolves.toMatchObject({ ok: true, result: { revision: 0, messages: [] } });
    const messages = [{ role: "user", content: "hi", timestamp: 1 }];
    await expect(actions.handleFrame(frame({ action: "bot.session.save", session: { baseRevision: 0, messages } })))
      .resolves.toMatchObject({ ok: true, result: { revision: 1 } });
    await expect(actions.handleFrame(frame({ action: "bot.session.save", session: { baseRevision: 0, messages } })))
      .resolves.toMatchObject({ ok: false, code: "stale_generation" });
  });

  it("accepts events only in order, starting at 0 for each run", async () => {
    const { actions, events } = setup();
    const event = (seq: number) => frame({ action: "bot.event", event: { seq, event: { type: "assistant_delta", text: `part ${seq}` } } });
    await expect(actions.handleFrame(event(1))).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
    await expect(actions.handleFrame(event(0))).resolves.toMatchObject({ ok: true, result: { accepted: true } });
    await expect(actions.handleFrame(event(1))).resolves.toMatchObject({ ok: true });
    await expect(actions.handleFrame(event(1))).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it("checkpoints each tool call before and after dispatch and never dispatches a repeat", async () => {
    const { actions, tools } = setup();
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: true, result: { ok: true, content: [{ text: "saved" }] } });
    const checkpoints = await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" });
    expect(checkpoints).toEqual([expect.objectContaining({ toolCallId: "call_1", phase: "observed_complete", outcomeRef: "artifact_1", effectClass: "write" })]);
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: false, code: "denied" });
    expect(tools.dispatch).toHaveBeenCalledTimes(1);
    // A capability outside the binding is refused before anything is recorded.
    await expect(actions.handleFrame(tool({ toolCallId: "call_2", capability: "memory.search", args: { query: "x", limit: 3 } } as never)))
      .resolves.toMatchObject({ ok: false, code: "denied" });
    expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" })).toHaveLength(1);
  });

  it("records refusals as complete, and failures and timeouts as effect unknown", async () => {
    let mode: "refuse" | "throw" | "hang" = "refuse";
    const { actions } = setup({
      toolTimeoutMs: 50,
      tools: {
        dispatch: vi.fn(async (_binding, _request, signal: AbortSignal) => {
          if (mode === "refuse") throw new BotBrokerActionError("not_granted");
          if (mode === "throw") throw new Error("provider exploded at /home/matrix");
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          return { result: { ok: true as const, content: [{ type: "text" as const, text: "late" }] } };
        }),
      },
    });
    await expect(actions.handleFrame(tool({ toolCallId: "call_refuse" }))).resolves.toMatchObject({ ok: false, code: "not_granted" });
    mode = "throw";
    const thrown = await actions.handleFrame(tool({ toolCallId: "call_throw" }));
    expect(thrown).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(thrown)).not.toContain("/home/matrix");
    mode = "hang";
    await expect(actions.handleFrame(tool({ toolCallId: "call_hang" }))).resolves.toMatchObject({ ok: false, code: "timeout" });
    const phases = Object.fromEntries((await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" }))
      .map((checkpoint) => [checkpoint.toolCallId, checkpoint.phase]));
    expect(phases).toEqual({ call_refuse: "observed_complete", call_throw: "effect_unknown", call_hang: "effect_unknown" });
  });

  it("forwards bot inference with tools on the route's own model and credential", async () => {
    const fetchImpl = vi.fn(async () => new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
    const { actions } = setup({ fetchImpl: fetchImpl as never });
    const inference = (body: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
      version: 1, action: "inference.messages", requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "6",
      method: "POST", path: "/v1/messages?beta=true", headers: { "anthropic-version": "2023-06-01" }, body: JSON.stringify(body), ...overrides,
    });
    const tools = Array.from({ length: 3 }, (_, index) => ({ name: `tool_${index}`, input_schema: { type: "object" } }));
    await expect(actions.handleFrame(inference({ model: "claude-sonnet-5", stream: true, messages: [], tools })))
      .resolves.toMatchObject({ ok: true, status: 200, headers: { "content-type": "text/event-stream" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://relay.test/v1/messages?beta=true");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer funded-token");
    expect(headers.get("x-matrix-funded-claim-key")).toBe(RUNTIME);

    await expect(actions.handleFrame(inference({ model: "claude-opus-5", stream: true, messages: [] }))).resolves.toMatchObject({ ok: false, error: "action_denied" });
    const tooMany = Array.from({ length: 65 }, (_, index) => ({ name: `t${index}` }));
    await expect(actions.handleFrame(inference({ model: "claude-sonnet-5", stream: true, messages: [], tools: tooMany }))).resolves.toMatchObject({ ok: false, error: "invalid_request" });
    await expect(actions.handleFrame(inference({ model: "claude-sonnet-5", stream: true }, {
      action: "inference.chat_completions", path: "/v1/chat/completions", headers: {},
    }))).resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(actions.handleFrame(inference({ model: "claude-sonnet-5", stream: true }, { executionGeneration: "5" })))
      .resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(actions.handleFrame(inference({ model: "claude-sonnet-5", stream: true }, { path: "/v1/files" }))).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("publishes one event at a time per run, even when frames race", async () => {
    let release: () => void = () => undefined;
    let fail = true;
    const { actions, events } = setup({
      publish: () => new Promise<void>((resolve, reject) => {
        release = () => (fail ? reject(new Error("chat store unavailable")) : resolve());
      }),
    });
    const event = (seq: number) => frame({ action: "bot.event", event: { seq, event: { type: "assistant_delta", text: `part ${seq}` } } });
    const first = actions.handleFrame(event(0));
    const duplicate = actions.handleFrame(event(0));
    const next = actions.handleFrame(event(1));
    await expect(duplicate).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
    await expect(next).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
    await vi.waitFor(() => expect(events.publish).toHaveBeenCalledTimes(1));
    release();
    // A failed publish frees the sequence number for the worker's retry.
    await expect(first).resolves.toMatchObject({ ok: false, code: "unavailable" });
    fail = false;
    const retry = actions.handleFrame(event(0));
    await vi.waitFor(() => expect(events.publish).toHaveBeenCalledTimes(2));
    release();
    await expect(retry).resolves.toMatchObject({ ok: true, result: { accepted: true } });
  });

  it("keeps a bound run's event order when released runs fill the tracker", async () => {
    const { actions, registry } = setup({ maxTrackedRuns: 2 });
    const event = (seq: number, runtime = RUNTIME, runId = "run_broker1") => frame({
      action: "bot.event", runtimeHandle: runtime, runId, event: { seq, event: { type: "assistant_delta", text: `part ${seq}` } },
    });
    await expect(actions.handleFrame(event(0))).resolves.toMatchObject({ ok: true });
    for (let index = 0; index < 4; index += 1) {
      const runtime = `runtime_${String(index).repeat(32)}`;
      const runId = `run_other${index}`;
      registry.bind({ ...binding, runtimeHandle: runtime, runId });
      await expect(actions.handleFrame(event(0, runtime, runId))).resolves.toMatchObject({ ok: true });
      registry.release(runtime);
    }
    // The live run's next event still follows its own order.
    await expect(actions.handleFrame(event(1))).resolves.toMatchObject({ ok: true });
    await expect(actions.handleFrame(event(1))).resolves.toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("writes the pre-dispatch checkpoint atomically", async () => {
    let failOnce = true;
    const { actions, tools } = setup({
      checkpoints: (repository) => ({
        ...repository,
        markDispatched: async (input, executor) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("connection reset");
          }
          return repository.markDispatched(input, executor);
        },
      }),
    });
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" })).toEqual([]);
    expect(tools.dispatch).not.toHaveBeenCalled();
    // Nothing was recorded, so the same tool call may run once the database recovers.
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: true });
    expect(tools.dispatch).toHaveBeenCalledTimes(1);
  });

  it("never dispatches a tool for a run released while its checkpoint was written", async () => {
    const { actions, tools } = setup({
      checkpoints: (repository, registry) => ({
        ...repository,
        markDispatched: async (input, executor) => {
          registry.release(RUNTIME);
          return repository.markDispatched(input, executor);
        },
      }),
    });
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: false, code: "stale_generation" });
    expect(tools.dispatch).not.toHaveBeenCalled();
    expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" }))
      .toEqual([expect.objectContaining({ toolCallId: "call_1", phase: "observed_complete", outcomeRef: null })]);
  });

  it("times out a tool whose dispatcher ignores cancellation", async () => {
    const { actions } = setup({
      toolTimeoutMs: 50,
      tools: { dispatch: vi.fn(() => new Promise<never>(() => undefined)) },
    });
    await expect(actions.handleFrame(tool())).resolves.toMatchObject({ ok: false, code: "timeout" });
    expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" }))
      .toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
  });

  describe("inference authorization and failures", () => {
    const inference = (overrides: Record<string, unknown> = {}) => ({
      version: 1, action: "inference.messages", requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "6",
      method: "POST", path: "/v1/messages?beta=true", headers: {},
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }), ...overrides,
    });
    const streamed = () => new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });

    it("answers provider_unavailable when credentials cannot be resolved", async () => {
      const fetchImpl = vi.fn(async () => streamed());
      const { actions } = setup({
        fetchImpl: fetchImpl as never,
        resolveCredentials: () => vi.fn(async () => { throw new Error("credential issuance failed at /home/matrix"); }),
      });
      const response = await actions.handleFrame(inference());
      expect(response).toEqual({ version: 1, requestId: REQUEST_ID, ok: false, error: "provider_unavailable" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("never sends for a run released while its credential was resolved", async () => {
      const fetchImpl = vi.fn(async () => streamed());
      const { actions } = setup({
        fetchImpl: fetchImpl as never,
        resolveCredentials: (registry) => vi.fn(async () => {
          registry.release(RUNTIME);
          return { env: { ANTHROPIC_API_KEY: "own-key" } };
        }),
      });
      await expect(actions.handleFrame(inference())).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("waits on the funded queue for the run's lifetime and reauthorizes before the first queued send", async () => {
      const fetchImpl = vi.fn(async () => streamed());
      let queued: (() => Promise<unknown>) | undefined;
      let waitSignal: AbortSignal | undefined;
      const fundedAdmission: FundedAdmissionQueue = {
        run: vi.fn(async (input, attempt) => {
          waitSignal = input.signal;
          await new Promise<void>((resolve) => { queued = async () => resolve(); });
          const result = await attempt();
          return (result as { kind: "done"; value: unknown }).value as never;
        }),
        close: vi.fn(),
      };
      const { actions, registry, lifetime } = setup({ fetchImpl: fetchImpl as never, fundedAdmission });
      const pending = actions.handleFrame(inference());
      await vi.waitFor(() => expect(queued).toBeDefined());
      // The queue bounds the wait itself; no 30 second send deadline applies while queued.
      expect(waitSignal?.aborted).toBe(false);
      registry.release(RUNTIME);
      expect(waitSignal?.aborted).toBe(true);
      expect(lifetime.signal.aborted).toBe(false);
      await queued!();
      await expect(pending).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

it("rechecks canonical managed run authority after a funded queue wait before sending", async () => {
  let allowed = true;
  const fetchImpl = vi.fn();
  const fundedAdmission = { run: async (_input: unknown, work: () => Promise<unknown>) => { allowed = false; const result = await work() as { value: unknown }; return result.value; } } as unknown as FundedAdmissionQueue;
  const { actions } = setup({ fetchImpl: fetchImpl as never, fundedAdmission, revalidateBinding: async () => allowed });
  const response = await actions.handleFrame({ version: 1, requestId: REQUEST_ID, runtimeHandle: RUNTIME, executionGeneration: "6",
    action: "inference.messages", method: "POST", path: "/v1/messages?beta=true", headers: {}, body: JSON.stringify({ model: binding.route.modelId, stream: true }) });
  expect(response).toMatchObject({ ok: false, error: "action_denied" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("waits for preflight without recording a dispatched effect and stops noncooperative approval work", async () => {
  const prepare = vi.fn(async () => new Promise<void>(() => {}));
  const { actions, registry, tools } = setup({ tools: { prepare } });
  const work = actions.handleFrame(tool());
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" })).toEqual([]);
  registry.cancelInference(binding);
  await expect(work).resolves.toMatchObject({ ok: false, code: "stale_generation" });
  expect(tools.dispatch).not.toHaveBeenCalled();
  expect(await createBotCheckpointsRepository(db).listForRun({ ownerId: OWNER, runId: "run_broker1" })).toEqual([]);
});
