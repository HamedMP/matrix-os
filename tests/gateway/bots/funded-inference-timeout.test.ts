import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { createIsolatedChatAuthority } from "../../../packages/gateway/src/chat/isolated-chat-envelope.js";
import { createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeRuntimeBotInferenceRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { forwardBotInference } from "../../../packages/gateway/src/bots/broker-inference.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createFundedAdmissionQueue } from "../../../packages/gateway/src/funded-ai/admission-queue.js";

const model = "@cf/zai-org/glm-5.3-flash";
const request: ScopeRuntimeBotInferenceRequest = {
  version: 1, action: "inference.chat_completions", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
  runtimeHandle: `runtime_${"e".repeat(32)}`, executionGeneration: "6", method: "POST",
  path: "/v1/chat/completions", headers: {}, body: JSON.stringify({ model, stream: true, messages: [] }),
};
const binding: ManagedPiRuntimeBinding = {
  runtimeHandle: request.runtimeHandle, executionGeneration: request.executionGeneration,
  kind: "managed_chat", ownerId: "owner", chatId: "chat_funded", runId: "run_funded",
  workspace: { kind: "chat_workspace" }, rootFingerprint: "f".repeat(64), accessSourceId: "matrix_included",
  route: { api: "openai-completions", modelId: model, input: ["text"], contextWindow: 128_000, maxOutputTokens: 8_192 },
  capabilities: ["artifact.read"], requestClass: "interactive",
};
const authorization = { allowed: true, accessSourceId: "matrix_included", allowedModelIds: [model], allowedEgressOrigins: [] } as const;
const responseBody = 'data: {"choices":[{"delta":{"content":"Complete buffered reply."}}]}\n\ndata: [DONE]\n\n';
const response = () => new Response(responseBody, { headers: { "content-type": "text/event-stream" } });

beforeEach(() => {
  vi.useFakeTimers();
  // Node's native AbortSignal.timeout uses internal timers outside Vitest's
  // clock. Supply a timer-backed real AbortSignal; AbortSignal.any and abort
  // listeners stay real, so these tests exercise cancellation propagation.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), delay);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function setup(delay = 31_000, immediateHeaders = false) {
  const lifetime = new AbortController();
  const fundedAdmission = createFundedAdmissionQueue();
  let signal: AbortSignal | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init!.signal!;
    signal.throwIfAborted();
    if (immediateHeaders) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            signal!.removeEventListener("abort", aborted);
            controller.enqueue(new TextEncoder().encode(responseBody));
            controller.close();
          }, delay);
          const aborted = () => { clearTimeout(timer); controller.error(signal!.reason); };
          signal!.addEventListener("abort", aborted, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { signal!.removeEventListener("abort", aborted); resolve(response()); }, delay);
      const aborted = () => { clearTimeout(timer); reject(signal!.reason); };
      signal!.addEventListener("abort", aborted, { once: true });
    });
  });
  const resolveCredentials = vi.fn(async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test-only", ANTHROPIC_BASE_URL: "https://relay.example.invalid" } }));
  const revalidateBinding = vi.fn(async () => true);
  return { deps: { homePath: "/tmp", lifetime: lifetime.signal, fundedAdmission, fetchImpl, resolveCredentials, revalidateBinding },
    lifetime, fetchImpl, fundedAdmission, signal: () => signal };
}

describe("Pi Matrix funded inference deadline", () => {
  it("reads an SSE body completing after 31 seconds when fetch returns headers immediately", async () => {
    const fixture = setup(31_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ ok: true, status: 200, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("aborts an unfinished SSE body at 120 seconds after immediate headers without retry", async () => {
    const fixture = setup(121_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("cancels immediately while reading an SSE body after headers have returned", async () => {
    const fixture = setup(121_000, true);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      fixture.lifetime.abort(new DOMException("Cancelled", "AbortError"));
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toBe(fixture.lifetime.signal.reason);
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("returns a complete buffered funded response after 31 seconds without a paid retry", async () => {
    const fixture = setup();
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ ok: true, status: 200, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("aborts an unfinished funded request at 120 seconds and fails closed without retry", async () => {
    const fixture = setup(121_000);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(fixture.signal()?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("propagates lifetime cancellation immediately instead of waiting for the funded deadline", async () => {
    const fixture = setup(121_000);
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(1_000);
      fixture.lifetime.abort(new DOMException("Cancelled", "AbortError"));
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toBe(fixture.lifetime.signal.reason);
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it.each([429, 503])("never retries a provider %s response without the relay capacity marker", async (status) => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValue(new Response("provider error", { status }));
    try {
      await expect(forwardBotInference(request, binding, () => authorization, fixture.deps))
        .resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("retries only a marked relay capacity refusal before accepting a delayed response", async () => {
    const fixture = setup();
    fixture.fetchImpl.mockResolvedValueOnce(new Response("busy", { status: 429,
      headers: { "x-matrix-funded-reason": "capacity_busy" } }));
    try {
      const pending = forwardBotInference(request, binding, () => authorization, fixture.deps);
      await vi.advanceTimersByTimeAsync(31_250);
      await expect(pending).resolves.toMatchObject({ ok: true, body: responseBody });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(2);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("rechecks authority after a capacity wait and never sends a revoked second attempt", async () => {
    const fixture = setup();
    let allowed = true;
    fixture.fetchImpl.mockImplementationOnce(async () => {
      allowed = false;
      return new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "capacity_busy" } });
    });
    try {
      const pending = forwardBotInference(request, binding, () => allowed ? authorization : { allowed: false }, fixture.deps);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });

  it("retains the owner Anthropic credential deadline at 30 seconds", async () => {
    const fixture = setup();
    try {
      const ownerModel = "claude-sonnet-5";
      const ownerBinding = { ...binding, accessSourceId: "owner_anthropic_key" as const,
        route: { ...binding.route, api: "anthropic-messages" as const, modelId: ownerModel } };
      const pending = forwardBotInference({ ...request, action: "inference.messages", path: "/v1/messages",
        body: JSON.stringify({ model: ownerModel, stream: true, messages: [] }) }, ownerBinding,
        () => ({ ...authorization, accessSourceId: "owner_anthropic_key", allowedModelIds: [ownerModel] }),
        { ...fixture.deps, resolveCredentials: async () => ({ env: { ANTHROPIC_API_KEY: "test-only" } }) });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(fixture.signal()?.reason).toMatchObject({ name: "TimeoutError" });
      expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { fixture.fundedAdmission.close(); }
  });
});


describe("server-owned isolated ordinary Chat broker", () => {
  async function fixture(real = false) {
    vi.useRealTimers(); vi.restoreAllMocks();
    const database = real ? await createRealBotStateDatabase() : await createBotStateDatabase();
    await insertChat(database.db, binding.chatId, binding.ownerId);
    const config = { phaseId: "phase_one", ownerId: binding.ownerId, machineId: "machine_test", runtimeSlot: "pv-2438-eaef1eaf",
      runtimeTokenEpoch: 1, runtimeCredentialSha256: "a".repeat(64), chatId: binding.chatId, modelId: model,
      sourceSha: "b".repeat(40), startsAt: "2026-10-10T12:00:00.000Z", expiresAt: "2026-10-10T12:20:00.000Z" };
    let clock = new Date("2026-10-10T12:01:00.000Z");
    let identity = { ownerId: config.ownerId, machineId: config.machineId, runtimeSlot: config.runtimeSlot,
      credentialSha256: config.runtimeCredentialSha256, sourceSha: config.sourceSha };
    const authority = (db = database.db) => createIsolatedChatAuthority({ config, db, identity: () => identity, now: () => clock });
    await database.db.transaction().execute(async trx => {
      await sql`insert into chat_messages (id,chat_id,seq,role,state,parts,byte_count,created_at)
        values ('msg_isolated', ${binding.chatId}, 1, 'user', 'committed', '[]', 0, ${config.startsAt}::timestamptz)`.execute(trx);
      await sql`insert into chat_turns (id,chat_id,client_request_id,base_message_seq,input_message_id,status,created_at,updated_at)
        values ('turn_isolated', ${binding.chatId}, 'req_isolated', 0, 'msg_isolated', 'running', ${config.startsAt}::timestamptz, ${config.startsAt}::timestamptz)`.execute(trx);
      await sql`insert into chat_runs (id,chat_id,turn_id,client_request_id,attempt,driver_kind,instance_id,selection,
        interaction_mode,permission_mode,status,history_boundary_seq,capability_snapshot,created_at,updated_at)
        values (${binding.runId}, ${binding.chatId}, 'turn_isolated', 'req_isolated', 1, 'matrix_pi', 'matrix_pi_default', '{}',
          'default', 'full_access', 'running', 0, '[]', ${config.startsAt}::timestamptz, ${config.startsAt}::timestamptz)`.execute(trx);
    });
    const isolatedChat = authority();
    const run = { ...binding, route: { ...binding.route, maxOutputTokens: 256 } };
    const payload = { model, stream: true, max_tokens: 256, messages: [{ role: "user", content: "Hello" }] };
    const frame = { ...request, body: JSON.stringify(payload) };
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const deps = { isolatedChat, homePath: "/tmp", lifetime: new AbortController().signal, fetchImpl,
      resolveCredentials: async () => ({ env: { ANTHROPIC_AUTH_TOKEN: "test-only", ANTHROPIC_BASE_URL: "https://relay.example.invalid" } }),
      revalidateBinding: async () => true };
    return { ...database, authority, isolatedChat, run, payload, frame, fetchImpl, deps,
      setClock: (value: Date) => { clock = value; }, setIdentity: (value: typeof identity) => { identity = value; }, identity };
  }

  it.each([false, true])("keeps first-run and pre-send state across concurrent frames, rebinding and restart (pooled=%s)", async real => {
    if (real && !process.env.MATRIX_TEST_POSTGRES_URL) return;
    const f = await fixture(real);
    let independent: typeof f.db | undefined;
    try {
      if (real) {
        const schema = (await sql<{name: string}>`select current_schema() as name`.execute(f.db)).rows[0]!.name;
        independent = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.MATRIX_TEST_POSTGRES_URL, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000` }) }) });
      }
      expect(f.isolatedChat.select({ ownerId: binding.ownerId, chatId: binding.chatId, modelId: model })).toBe(true);
      await f.isolatedChat.claim(f.run);
      const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => forwardBotInference(f.frame, f.run, () => authorization, { ...f.deps, isolatedChat: f.authority(i % 2 && independent ? independent : f.db) })));
      expect(responses.filter(value => value.ok)).toHaveLength(1);
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      await expect(f.authority().claim({ ...f.run, runId: "run_next", runtimeHandle: `runtime_${"a".repeat(32)}` })).rejects.toThrow("unavailable");
      expect(await f.authority().consume(f.run)).toBe(false);
      await f.db.deleteFrom("chats").where("id", "=", binding.chatId).execute();
      expect((await sql`select * from managed_pi_isolated_phases`.execute(f.db)).rows).toHaveLength(1);
    } finally { await independent?.destroy(); await f.destroy(); }
  });

  it.each(["capacity", "unknown", "abort"])("never restores a consumed generation after %s", async kind => {
    const f = await fixture();
    try {
      await f.isolatedChat.claim(f.run);
      f.fetchImpl.mockImplementation(async () => {
        if (kind === "capacity") return new Response("busy", { status: 429, headers: { "x-matrix-funded-reason": "capacity_busy" } });
        throw new DOMException("fixture", kind === "abort" ? "AbortError" : "TimeoutError");
      });
      const queue = createFundedAdmissionQueue();
      try { await expect(forwardBotInference(f.frame, f.run, () => authorization, { ...f.deps, fundedAdmission: queue })).resolves.toMatchObject({ ok: false }); }
      finally { queue.close(); }
      await expect(forwardBotInference(f.frame, f.run, () => authorization, { ...f.deps, isolatedChat: f.authority() })).resolves.toMatchObject({ ok: false, error: "action_denied" });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { await f.destroy(); }
  });

  it("caps retained phases without evicting or rebinding spent state", async () => {
    const f = await fixture();
    try {
      await sql`insert into managed_pi_isolated_phases (phase_id,config_hash,owner_id,chat_id,run_id,runtime_handle,execution_generation,expires_at)
        select 'saved_' || i, ${"a".repeat(64)}, 'owner', 'chat_old', 'run_old', ${binding.runtimeHandle}, '1', '2026-01-01'::timestamptz
        from generate_series(1,64) i`.execute(f.db);
      await expect(f.isolatedChat.claim(f.run)).rejects.toThrow("unavailable");
      expect((await sql`select * from managed_pi_isolated_phases`.execute(f.db)).rows).toHaveLength(64);
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });

  it("refuses full-body byte excess, changed model/output, tools, reasoning and unsupported fields before consumption", async () => {
    const f = await fixture();
    try {
      await f.isolatedChat.claim(f.run);
      const bodies = [{ ...f.payload, max_tokens: 8192 }, { ...f.payload, model: "other" },
        { ...f.payload, tools: [{ name: "read_artifact" }] }, { ...f.payload, reasoning_effort: "max" },
        { ...f.payload, unknown: true }, { ...f.payload, messages: [{ role: "assistant", content: "continuation" }] },
        { ...f.payload, messages: [{ role: "user", content: "界".repeat(45000) }] }];
      for (const body of bodies) await expect(forwardBotInference({ ...f.frame, body: JSON.stringify(body) }, f.run, () => authorization, f.deps))
        .resolves.toMatchObject({ ok: false, error: "invalid_request" });
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect((await sql<{ dispatched: boolean }>`select dispatched from managed_pi_isolated_phases`.execute(f.db)).rows[0]!.dispatched).toBe(false);
      await expect(forwardBotInference(f.frame, f.run, () => authorization, f.deps)).resolves.toMatchObject({ ok: true });
    } finally { await f.destroy(); }
  });

  it("fails closed for changed identity/source/credential, expiry and database failure without widening other owners", async () => {
    const f = await fixture();
    try {
      expect(f.isolatedChat.select({ ownerId: "other", chatId: binding.chatId, modelId: model })).toBe(false);
      for (const changed of [{ ...f.identity, ownerId: "other" }, { ...f.identity, machineId: "other" },
        { ...f.identity, runtimeSlot: "primary" }, { ...f.identity, sourceSha: "c".repeat(40) },
        { ...f.identity, credentialSha256: "c".repeat(64) }]) {
        f.setIdentity(changed);
        expect(() => f.isolatedChat.select({ ownerId: binding.ownerId, chatId: binding.chatId, modelId: model })).toThrow("unavailable");
        await expect(f.isolatedChat.claim(f.run)).rejects.toThrow("unavailable");
      }
      f.setIdentity(f.identity); f.setClock(new Date("2026-10-10T12:20:00.000Z"));
      expect(await f.isolatedChat.consume(f.run)).toBe(false);
      f.setClock(new Date("2026-10-10T12:01:00.000Z"));
      await sql`drop table managed_pi_isolated_phases`.execute(f.db);
      await expect(forwardBotInference(f.frame, f.run, () => authorization, f.deps)).resolves.toMatchObject({ ok: false, error: "provider_unavailable" });
      expect(f.fetchImpl).not.toHaveBeenCalled();
    } finally { await f.destroy(); }
  });
});
