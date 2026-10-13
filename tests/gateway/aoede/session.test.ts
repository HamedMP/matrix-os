import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
import { createAoedeRepository } from "../../../packages/gateway/src/aoede/repository.js";
import { AoedeTaskNotStartedError, createAoedeSessionService } from "../../../packages/gateway/src/aoede/session.js";
import { createAoedeGatewayRoutes } from "../../../packages/gateway/src/aoede/routes.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";
import { createAoedePlatformClient } from "../../../packages/gateway/src/aoede/platform-client.js";
import { loadPlatformSpeechRuntimeConfig } from "../../../packages/gateway/src/speech/platform-client.js";
import type { AoedePlatformClient, AoedeSideband } from "../../../packages/gateway/src/aoede/platform-client.js";

// Required real Postgres: connection/setup failures deliberately fail this suite.
const databaseUrl = process.env.AOEDE_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test")) throw new Error("Dedicated AOEDE_TEST_DATABASE_URL required");
const db = createAppDb(databaseUrl);
const ownerId = `aoede_test_${randomUUID().replaceAll("-", "")}`;
const principal = { userId: ownerId, source: "jwt" as const };
const repo = createAoedeRepository(db.kysely, { ownerId, runtimeId: "test-machine/main" });
beforeAll(() => repo.bootstrap());
beforeEach(async () => {
  await db.kysely.deleteFrom("aoede_sessions").where("owner_id", "=", ownerId).execute();
});
afterAll(async () => {
  await db.kysely.deleteFrom("aoede_sessions").where("owner_id", "=", ownerId).execute();
  await db.kysely.destroy();
});

function provider() {
  let mintCount = 0;
  let event: (data: unknown) => void = () => {};
  const sent: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const socket: AoedeSideband = {
    send(frame) { sent.push(frame); }, close() {},
  };
  const client: AoedePlatformClient = {
    ownerId, runtimeId: "test-machine/main",
    async mint() { mintCount++; return { providerSessionId: `live_${mintCount}`, sdp: "answer" }; },
    async attach(_id, onEvent) { event = onEvent; return socket; },
    async close(id) { closed.push(id); },
  };
  return { client, sent, closed, event: (data: unknown) => event(data), count: () => mintCount };
}

describe("Aoede owner lifecycle on Postgres", () => {
  it.each([[409, 409], [429, 429], [401, 503], [403, 503], [500, 503]])("platform HTTP %s reaches browser as %s after cleanup", async (upstream, expected) => {
    const fetchFn = vi.fn(async () => new Response("private provider payload", { status: upstream }));
    const platform = createAoedePlatformClient(loadPlatformSpeechRuntimeConfig({
      MATRIX_PLATFORM_SPEECH_ENABLED: "true", MATRIX_PLATFORM_SPEECH_ORIGIN: "https://platform.invalid",
      MATRIX_HANDLE: "test", MATRIX_CLERK_USER_ID: ownerId, MATRIX_MACHINE_ID: "test-machine",
      MATRIX_RUNTIME_SLOT: "main", MATRIX_PLATFORM_SPEECH_RUNTIME_TOKEN: "a".repeat(64),
    })!, { fetchFn });
    const service = createAoedeSessionService({ repository: repo, platform });
    const app = createAoedeGatewayRoutes({ service, getPrincipal: () => principal });
    const request = { clientRequestId: randomUUID(), sdp: "offer" };
    try {
      const response = await app.request("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ error: "Voice request failed" });
      expect((await repo.latest())?.state).toBe("interrupted");
      const retry = await app.request("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      expect(retry.status).toBe(409);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally { await service.shutdown(); }
  });

  it("retains only the latest owner checkpoint", async () => {
    const first = (await repo.reserve(randomUUID(), "first")).record;
    await repo.checkpoint(first.id, [{role: "user", text: "older", offset: 0}], first.checkpoint_epoch);
    const latest = (await repo.reserve(randomUUID(), "latest")).record;
    await repo.checkpoint(latest.id, [{role: "user", text: "latest", offset: 0}], latest.checkpoint_epoch);
    expect((await repo.get(first.id))?.checkpoint).toEqual([]);
    expect((await repo.get(first.id))?.checkpoint_until).toBeNull();
    expect((await repo.get(latest.id))?.checkpoint).toHaveLength(1);
  });
  it("dispatch timeout after admitted work reports uncertainty once without replay or a false no-changes claim", async () => {
    const p = provider(), frames: any[] = [];
    let calls = 0, finish: () => void = () => {};
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 0,
      finalizationMs: 5, appendTimeoutMs: 20,
      emit: (_owner, message, connection) => frames.push({ ...message, connection }),
      async dispatch(ctx) {
        calls++; await ctx.record({ chat_id: (await repo.get(ctx.sessionId))!.chat_id!, run_id: "run_admitted" });
        await new Promise<void>(resolve => { finish = resolve; });
      },
    });
    try {
      const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
      const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
      p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id }); await ready;
      const event = { type: "session.delegation.created", offset_ms: 0,
        delegation: { id: "del_timeout", target: "client", type: "delegation" } };
      p.event(event);
      await expect.poll(() => frames.find(f => f.type === "aoede:task_error"), { timeout: 35_000 }).toBeTruthy();
      const failure = frames.find(f => f.type === "aoede:task_error");
      expect(failure).toMatchObject({ sessionId: a.sessionId, delegationId: "del_timeout", outcome: "uncertain", connection: "tab-a" });
      expect(failure.message).not.toMatch(/not started|no changes/i);
      finish(); p.event(event); await new Promise(resolve => setTimeout(resolve, 50));
      expect(calls).toBe(1);
      expect((await repo.delegations(a.sessionId))[0]).toMatchObject({ state: "uncertain", chat_id: (await repo.get(a.sessionId))!.chat_id, run_id: "run_admitted" });
    } finally { finish(); await service.shutdown(); }
  }, 40_000);

  it("shutdown abort rejection never delivers stale task errors", async () => {
    const p = provider(), frames: any[] = [];
    let entered = false;
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 0, finalizationMs: 5,
      emit: (_owner, message) => frames.push(message),
      async dispatch(ctx) {
        entered = true;
        await new Promise<void>((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      },
    });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
    p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id }); await ready;
    p.event({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "del_abort", target: "client", type: "delegation" } });
    await expect.poll(() => entered).toBe(true);
    await service.shutdown();
    expect(frames.filter(f => f.type === "aoede:task_error")).toEqual([]);
  });

  it.each(["not_started", "uncertain"] as const)("claimed %s failure is visible only on the invoking live session and is never replayed", async outcome => {
    const p = provider(), frames: any[] = [];
    let calls = 0;
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 0,
      finalizationMs: 5, appendTimeoutMs: 20,
      emit: (_owner, message, connection) => frames.push({ ...message, connection }),
      async dispatch() { calls++; throw outcome === "not_started" ? new AoedeTaskNotStartedError() : new Error("secret mutation uncertainty"); },
    });
    try {
      const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
      const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
      p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id }); await ready;
      const event = { type: "session.delegation.created", offset_ms: 0,
        delegation: { id: "del_error", target: "client", type: "delegation" } };
      p.event(event);
      await expect.poll(() => frames.find(f => f.type === "aoede:task_error")).toBeTruthy();
      const failure = frames.find(f => f.type === "aoede:task_error");
      expect(failure).toMatchObject({ sessionId: a.sessionId, delegationId: "del_error", outcome, connection: "tab-a" });
      expect(failure.message).not.toContain("secret");
      if (outcome === "uncertain") expect(failure.message).toContain("may already");
      await expect.poll(() => p.sent.some(f => f.type === "session.commentary.append")).toBe(true);
      const commentary = p.sent.find(f => f.type === "session.commentary.append")!;
      p.event({ type: "session.commentary.appended", client_event_id: commentary.event_id });
      p.event(event); await new Promise(resolve => setTimeout(resolve, 40));
      expect(calls).toBe(1);
      expect(frames.filter(f => f.type === "aoede:task_error")).toHaveLength(1);
      expect((await repo.delegations(a.sessionId))[0].state).toBe("uncertain");
    } finally { await service.shutdown(); }
  });

  it("explicit resume restores saved task outcomes only to its bound shell without replaying the mutation", async () => {
    const prior = (await repo.reserve(randomUUID(), "old-offer")).record;
    await repo.update(prior.id, { state: "active" });
    await repo.claim(prior.id, "del_saved");
    await repo.delegationResult(prior.id, "del_saved", { state: "done", chat_id: prior.chat_id });
    await repo.update(prior.id, { state: "closed" });
    const p = provider(), frames: any[] = [];
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5,
      emit: (_owner, message, connection) => frames.push({ ...message, connection }),
      async onReady(ctx, previousSessionId) {
        for (const binding of await repo.delegations(previousSessionId!)) ctx.emit({ type: "aoede:card",
          sessionId: ctx.sessionId, card: { id: binding.delegation_id, chatId: binding.chat_id!, title: "Saved task", status: "done" } });
      },
    });
    const fresh = await service.start(principal, { clientRequestId: randomUUID(), sdp: "resume-offer", resumeSessionId: prior.id });
    const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: fresh.sessionId });
    p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id }); await ready;
    await service.onClientMessage(principal, "tab-b", { type: "aoede:ready", sessionId: fresh.sessionId });
    expect(frames.filter(f => f.type === "aoede:card")).toEqual([{ type: "aoede:card", sessionId: fresh.sessionId,
      card: { id: "del_saved", chatId: prior.chat_id, title: "Saved task", status: "done" }, connection: "tab-a" }]);
    expect((await repo.delegations(fresh.sessionId))[0].session_id).toBe(prior.id);
    expect((await repo.delegations(prior.id))[0].state).toBe("done");
    await service.shutdown();
  });

  it("close during mint cannot orphan a provider that returns after the close request", async () => {
    const p = provider(); const mint = p.client.mint;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const minting = new Promise<void>((resolve) => { entered = resolve; });
    p.client.mint = async (input) => { entered(); await gate; return mint(input); };
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const starting = service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    await minting;
    const row = (await repo.latest())!;
    const closing = service.close(principal, row.id);
    release();
    await Promise.allSettled([starting, closing]);
    expect(p.closed).toEqual(["live_1"]);
    expect((await repo.get(row.id))?.state).not.toBe("active");
    await service.shutdown();
  });

  it("restart attaches only for cleanup and never dispatches reflected work or remints the old invocation", async () => {
    const invocation = randomUUID();
    const { record } = await repo.reserve(invocation, "saved-offer");
    await repo.update(record.id, { state: "active", provider_id: "live_crashed" });
    await repo.checkpoint(record.id, [{ role: "user", text: "save this context", offset: 100 }], record.checkpoint_epoch);
    await repo.claim(record.id, "del_unfinished");
    const p = provider(); let dispatched = false;
    const attach = p.client.attach;
    p.client.attach = async (id, event, disconnect) => {
      event({ type: "session.delegation.created", offset_ms: 100, delegation: { id: "del_unfinished", type: "delegation", target: "client" } });
      return attach(id, event, disconnect);
    };
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5,
      dispatch: async () => { dispatched = true; },
    });
    await service.recover();
    expect(p.count()).toBe(0);
    expect(p.closed).toEqual(["live_crashed"]);
    expect(dispatched).toBe(false);
    const snap = await service.snapshot(principal);
    expect(snap.session?.state).toBe("interrupted");
    expect(snap.session?.finalizationConfirmed).toBe(false);
    expect(snap.recovery.map((t) => t.text)).toEqual(["save this context"]);
    expect(snap.delegations[0].state).toBe("uncertain");
    await expect(service.start(principal, { clientRequestId: invocation, sdp: "offer" })).rejects.toThrow();
    expect(p.count()).toBe(0);
    await service.shutdown();
  });

  it("deletion fences stale checkpoints and 24-hour expiry erases saved text", async () => {
    const { record } = await repo.reserve(randomUUID(), "offer");
    const text = [{ role: "user" as const, text: "private text", offset: 0 }];
    await repo.checkpoint(record.id, text, record.checkpoint_epoch);
    await repo.clearRecovery();
    await repo.checkpoint(record.id, text, record.checkpoint_epoch);
    expect((await repo.get(record.id))?.checkpoint).toEqual([]);
    const current = (await repo.get(record.id))!;
    await repo.checkpoint(record.id, text, current.checkpoint_epoch);
    await db.kysely.updateTable("aoede_sessions").set({ checkpoint_until: new Date(Date.now() - 1) })
      .where("id", "=", record.id).execute();
    await repo.expireRecovery();
    expect((await repo.get(record.id))?.checkpoint).toEqual([]);
    const other = createAoedeRepository(db.kysely, { ownerId: "someone_else", runtimeId: repo.runtimeId });
    expect(await other.get(record.id)).toBeUndefined();
    expect(await other.claim(record.id, "del_stolen")).toBeUndefined();
    await expect(other.beginClose(record.id, "closed")).rejects.toThrow();
  });

  it("falls back to null only after a correlated provider rejection of delegation_id", async () => {
    const p = provider();
    let accepted = false;
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 0, finalizationMs: 5,
      dispatch: async (ctx) => { await ctx.append("commentary", "The verified result is ready.", ctx.delegationId); accepted = true; },
    });
    await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    p.event({ type: "session.delegation.created", offset_ms: 0, delegation: { id: "del_stale", type: "delegation", target: "client" } });
    await vi.waitFor(() => expect(p.sent).toHaveLength(1), { timeout: 2_000 });
    p.event({ type: "error", error: { client_event_id: randomUUID(), param: "delegation_id", type: "invalid_request_error", code: "invalid_value" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.sent).toHaveLength(1);
    p.event({ type: "error", error: { client_event_id: p.sent[0].event_id, param: "delegation_id", type: "invalid_request_error", code: "invalid_value" } });
    await vi.waitFor(() => expect(p.sent).toHaveLength(2), { timeout: 2_000 });
    expect(p.sent[1].delegation_id).toBeNull();
    p.event({ type: "session.commentary.appended", client_event_id: p.sent[1].event_id });
    await vi.waitFor(() => expect(accepted).toBe(true), { timeout: 2_000 });
    await service.shutdown();
  });

  it("retains startup expiry and transcript even when events arrive before attach resolves", async () => {
    const p = provider();
    const attach = p.client.attach;
    p.client.attach = async (id, event, disconnect) => {
      event({ type: "session.started", session: { id, expires_at: Date.now() / 1_000 + 30 } });
      event({ type: "session.input_transcript.delta", event_id: "early", start_ms: 0, end_ms: 10, delta: "hello" });
      return attach(id, event, disconnect);
    };
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    await new Promise((r) => setTimeout(r, 300));
    const snap = await service.snapshot(principal);
    expect(snap.session?.expiresAt).toBeInstanceOf(Date);
    expect(snap.recovery.map((t) => t.text)).toEqual(["hello"]);
    await service.shutdown();
  });

  it("closes minted provider despite checkpoint storage failure", async () => {
    const p = provider();
    p.client.attach = async (_id, event) => {
      event({ type: "session.input_transcript.delta", event_id: "rejected_checkpoint", start_ms: 0, end_ms: 1, delta: "save me" });
      throw new Error("attach failed");
    };
    const constraint = sql.id(`aoede_reject_${ownerId}`);
    // Real SQL write rejection scoped to this disposable test owner, not a fake repository.
    await sql`ALTER TABLE aoede_sessions ADD CONSTRAINT ${constraint}
      CHECK (owner_id <> ${sql.lit(ownerId)} OR checkpoint = '[]'::jsonb)`.execute(db.kysely);
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    try {
      await expect(service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" })).rejects.toThrow();
      expect(p.closed).toEqual(["live_1"]);
    } finally {
      await sql`ALTER TABLE aoede_sessions DROP CONSTRAINT ${constraint}`.execute(db.kysely);
      await service.shutdown();
    }
  });

  it("fresh never offers saved text or old uncertain delegations", async () => {
    const p = provider();
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    p.event({ type: "session.input_transcript.delta", event_id: "saved", start_ms: 5_000, end_ms: 5_100, delta: "create a note" });
    await repo.claim(a.sessionId, "del_crash");
    await service.shutdown();
    const contexts: string[] = [];
    const fresh = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5, graceMs: 0,
      dispatch: async (ctx) => { contexts.push(ctx.transcripts.map((t) => t.text).join("")); },
    });
    await fresh.recover();
    expect(p.count()).toBe(1);
    expect((await fresh.snapshot(principal)).delegations.find((d) => d.delegation_id === "del_crash")?.state).toBe("uncertain");
    await fresh.start(principal, { clientRequestId: randomUUID(), sdp: "fresh offer" });
    p.event({ type: "session.delegation.created", offset_ms: 100, delegation: { id: "del_new", type: "delegation", target: "client" } });
    await vi.waitFor(() => expect(contexts).toEqual([""]), { timeout: 2_000 });
    expect((await fresh.snapshot(principal)).delegations.some((d) => d.delegation_id === "del_crash")).toBe(false);
    await fresh.shutdown();
  });

  it("reservation scopes repeated resume, legacy null association, concurrent fresh and payload conflicts", async () => {
    const source = (await repo.reserve(randomUUID(), "source")).record;
    await repo.update(source.id, { state: "active", chat_id: null }); // Legacy session with no delegated Chat yet.
    await repo.claim(source.id, "legacy_pending");
    const invocation = randomUUID();
    const [a, duplicate] = await Promise.all([repo.reserve(invocation, "resume", source.id), repo.reserve(invocation, "resume", source.id)]);
    expect(a.record.id).toBe(duplicate.record.id);
    expect([a.created, duplicate.created].filter(Boolean)).toHaveLength(1);
    expect(a.record.chat_id).toBe(`chat_aoede_${source.id}`);
    const next = (await repo.reserve(randomUUID(), "resume-again", a.record.id)).record;
    expect(next.chat_id).toBe(a.record.chat_id);
    expect((await repo.delegations(next.id)).map(d => d.delegation_id)).toEqual(["legacy_pending"]);
    const [fresh, another] = await Promise.all([repo.reserve(randomUUID(), "fresh"), repo.reserve(randomUUID(), "fresh")]);
    expect(fresh.record.chat_id).not.toBe(another.record.chat_id);
    expect(await repo.delegations(fresh.record.id)).toEqual([]);
    await expect(repo.reserve(invocation, "changed-resume", source.id)).rejects.toThrow();
    const foreign = createAoedeRepository(db.kysely, { ownerId: "foreign", runtimeId: repo.runtimeId });
    await expect(foreign.reserve(randomUUID(), "stolen", source.id)).rejects.toThrow();
    const runtime = createAoedeRepository(db.kysely, { ownerId, runtimeId: "other-runtime" });
    await expect(runtime.reserve(randomUUID(), "stolen", source.id)).rejects.toThrow();
    expect((await repo.delegations(source.id))[0].state).toBe("pending");
  });

  it("a delegation result cannot reassign the durable conversation", async () => {
    const source = (await repo.reserve(randomUUID(), "source")).record;
    await repo.update(source.id, { state: "active" });
    await repo.claim(source.id, "delegation");
    await expect(repo.delegationResult(source.id, "delegation", { chat_id: "unrelated_chat" })).rejects.toThrow();
    expect((await repo.get(source.id))!.chat_id).toBe(source.chat_id);
    expect((await repo.delegations(source.id))[0].chat_id).toBeNull();
  });

  it("bounds text and rejects uncorrelated append acknowledgements without retrying", async () => {
    const p = provider();
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5, appendTimeoutMs: 20 });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    for (let i = 0; i < 30; i++) p.event({ type: "session.input_transcript.delta", event_id: `text_${i}`,
      delta: "x".repeat(2_000), start_ms: i * 3_000, end_ms: i * 3_000 + 100 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const snap = await service.snapshot(principal);
    expect(snap.recovery.length).toBeLessThanOrEqual(24);
    expect(snap.recovery.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(16_000);
    const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
    p.event({ type: "session.instructions.appended", client_event_id: randomUUID() });
    await ready;
    expect(p.sent).toHaveLength(1);
    await service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
    expect(p.sent).toHaveLength(1);
    await service.shutdown();
  });

  it("compensates attach failure, and never remints a failed invocation", async () => {
    const p = provider();
    p.client.attach = async () => { throw new Error("network down"); };
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const input = { clientRequestId: randomUUID(), sdp: "offer" };
    await expect(service.start(principal, input)).rejects.toThrow();
    expect(p.closed).toEqual(["live_1"]);
    await expect(service.start(principal, input)).rejects.toThrow();
    expect(p.count()).toBe(1);
    await service.shutdown();
  });

  it("authenticates routes, limits mutation bodies and exports/deletes owner recovery", async () => {
    const p = provider();
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const unauth = createAoedeGatewayRoutes({ service, getPrincipal() { throw new MissingRequestPrincipalError(); } });
    expect((await unauth.request("/session")).status).toBe(401);
    const routes = createAoedeGatewayRoutes({ service, getPrincipal: () => principal });
    const post = (body: string) => routes.request("/session", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await post("x".repeat(70_000))).status).toBe(413);
    expect((await post("{broken")).status).toBe(400);
    expect(p.count()).toBe(0);
    expect(await repo.latest()).toBeUndefined();
    const result = await post(JSON.stringify({ clientRequestId: randomUUID(), sdp: "offer" }));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect((await routes.request("/session")).status).toBe(200);
    expect((await routes.request("/recovery", { method: "DELETE", body: "x".repeat(2_000) })).status).toBe(413);
    expect((await routes.request("/recovery", { method: "DELETE" })).status).toBe(200);
    await service.shutdown();
  });

  it("only invoking socket resolves UI and only its correlated phase can complete", async () => {
    const p = provider();
    const frames: any[] = [];
    const effects: string[] = [];
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 0, finalizationMs: 5,
      emit: (_owner, message, connection) => frames.push({ ...message, connection }),
      async dispatch(ctx) {
        const resolved = await ctx.ui("resolve", "open_app", "notes");
        // Installed-registry validation belongs to injected actions, not the shell acknowledgement.
        if (resolved.slug !== "notes") throw new Error("not installed");
        const executed = await ctx.ui("execute", "open_app", resolved.slug);
        if (executed.status === "ok") effects.push("opened");
      },
    });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
    p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id }); await ready;
    p.event({ type: "session.delegation.created", offset_ms: 0,
      delegation: { id: "del_ui", type: "delegation", target: "client" } });
    await vi.waitFor(() => expect(frames.some((f) => f.phase === "resolve")).toBe(true));
    const resolve = frames.find((f) => f.phase === "resolve");
    expect(resolve.connection).toBe("tab-a");
    const ack = { type: "aoede:ui_result", sessionId: a.sessionId, correlationId: resolve.correlationId,
      phase: "resolve", status: "ok", slug: "notes" };
    await service.onClientMessage(principal, "tab-b", ack);
    expect(frames.some((f) => f.phase === "execute")).toBe(false);
    await service.onClientMessage(principal, "tab-a", ack);
    await vi.waitFor(() => expect(frames.some((f) => f.phase === "execute")).toBe(true));
    const execute = frames.find((f) => f.phase === "execute");
    await service.onClientMessage(principal, "tab-a", { ...ack, correlationId: execute.correlationId });
    expect(effects).toEqual([]);
    await service.onClientMessage(principal, "tab-a", { ...ack, correlationId: execute.correlationId, phase: "execute" });
    await vi.waitFor(() => expect(effects).toEqual(["opened"]));
    await service.shutdown();
  });

  it("mints once for duplicate invocation, attaches before answering, fences greeting by connection", async () => {
    const p = provider();
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const input = { clientRequestId: randomUUID(), sdp: "offer" };
    const [a, b] = await Promise.all([service.start(principal, input), service.start(principal, input)]);
    expect(a).toEqual(b);
    expect(p.count()).toBe(1);
    await expect(service.start(principal, { ...input, sdp: "changed" })).rejects.toThrow();
    await expect(service.start(principal, { ...input, resumeSessionId: a.sessionId })).rejects.toThrow();
    expect(p.count()).toBe(1);
    await expect(service.start({ ...principal, userId: "other" }, input)).rejects.toThrow();
    const ready = service.onClientMessage(principal, "tab-a", { type: "aoede:ready", sessionId: a.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(p.sent).toHaveLength(1);
    p.event({ type: "session.instructions.appended", client_event_id: p.sent[0].event_id });
    await ready;
    await service.onClientMessage(principal, "tab-b", { type: "aoede:ready", sessionId: a.sessionId });
    expect(p.sent).toHaveLength(1);
    await service.shutdown();
  });

  it("checkpoints late transcript before one persisted delegation dispatch, never replays uncertain work", async () => {
    const p = provider();
    const contexts: string[] = [];
    const service = createAoedeSessionService({ repository: repo, platform: p.client, graceMs: 10, finalizationMs: 5,
      async dispatch(ctx) {
        contexts.push(ctx.transcripts.map((t) => t.text).join(""));
        throw new Error("mutation outcome unknown");
      },
    });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    const delegation = { type: "session.delegation.created", offset_ms: 100,
      delegation: { id: "del_one", target: "client", type: "delegation" } };
    p.event(delegation);
    p.event({ type: "session.input_transcript.delta", event_id: "text_1", start_ms: 50, end_ms: 110, delta: "add milk" });
    await vi.waitFor(async () => {
      expect(contexts).toEqual(["add milk"]);
      const snapshot = await service.snapshot(principal);
      expect(snapshot.delegations.find((d) => d.delegation_id === "del_one")?.state).toBe("uncertain");
    }, { timeout: 2_000 });
    p.event(delegation);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(contexts).toEqual(["add milk"]);
    const snapshot = await service.snapshot(principal);
    expect(snapshot.recovery.map((t) => t.text)).toEqual(["add milk"]);
    expect(snapshot.delegations.find((d) => d.delegation_id === "del_one")?.state).toBe("uncertain");
    await service.clearRecovery(principal);
    expect((await service.snapshot(principal)).recovery).toEqual([]);
    await service.close(principal, a.sessionId);
    await service.shutdown();
  });

  it("supersedes only old session, finalizes once and explicit restart recovery does not mint", async () => {
    const p = provider();
    const service = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    const a = await service.start(principal, { clientRequestId: randomUUID(), sdp: "offer" });
    const b = await service.start(principal, { clientRequestId: randomUUID(), sdp: "new offer" });
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(p.closed).toContain(a.providerSessionId);
    await service.close(principal, a.sessionId);
    expect((await service.snapshot(principal)).session?.id).toBe(b.sessionId);
    p.event({ type: "session.closed", session: { id: b.providerSessionId }, usage: { seconds: 42 } });
    await vi.waitFor(async () => {
      expect((await service.snapshot(principal)).session?.state).toBe("closed");
    }, { timeout: 2_000 });
    await service.shutdown();
    const fresh = createAoedeSessionService({ repository: repo, platform: p.client, finalizationMs: 5 });
    await fresh.recover();
    expect(p.count()).toBe(2);
    await fresh.shutdown();
  });
});
