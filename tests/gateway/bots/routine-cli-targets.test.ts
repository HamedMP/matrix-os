import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import type { RoutineCliAction } from "../../../packages/contracts/src/bots/routine-cli.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createRoutineCliTargetService, type RoutineCliSourceContext } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { BOT, NOW, OWNER, OTHER_OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const scope = { ownerId: OWNER, computerId: "computer_one" };
const principal = { userId: OWNER, source: "jwt" as const };
const target = { botId: BOT, chatId: "chat_target", baseRevision: 0 };
let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>, home: string, agents: ChatAgentStore;
let clock: string, live: boolean, access: boolean;
const revalidateSource = vi.fn(async (_source: RoutineCliSourceContext, _action: RoutineCliAction, _executor: Transaction<OwnerBotDatabase>) => live);
const canAccessTarget = vi.fn(async () => access);
const source = (harness: RoutineCliSourceContext["harness"] = "claude"): RoutineCliSourceContext => ({
  ...scope, harness, generation: "generation_one", issuedAt: NOW, expiresAt: at(60_000), actions: ["read", "propose", "control"],
  identity: { kind: "chat_run", chatId: "chat_source", runId: "run_source", nativeTurnId: "turn_one", route: "native" },
});
const service = () => createRoutineCliTargetService({ db, scope, agents, now: () => new Date(clock), revalidateSource, canAccessTarget });
beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-routine-target-"));
  agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> }); await agents.bootstrap();
  await agents.createRecipeBot({ type: "personal", ownerId: OWNER }, { id: BOT, createHash: "a".repeat(64),
    fields: { name: "Recipe Bot", description: "", instructions: "Read the report", selection: { instanceId: "matrix_pi_default", model: "auto" } },
    recipeRef: { recipeId: "report", version: "1" } });
  await insertChat(db, target.chatId);
  await createBotBindingsRepository(db).bindDirect({ ...scope, ...target, now: NOW });
  clock = NOW; live = true; access = true; vi.clearAllMocks();
});
afterEach(async () => { await agents.close(); await destroy(); await rm(home, { recursive: true, force: true }); });

describe("remembered routine target with current source authority", () => {
  it.each(["claude", "codex", "hermes", "opencode", "pi"] as const)("reuses a saved route for %s without transferring authority", async harness => {
    const svc = service(); await svc.remember(principal, target);
    expect(await svc.resolve(source(harness), "read")).toMatchObject({ ...scope, botId: BOT, chatId: target.chatId, preferenceRevision: 1 });
    expect(await svc.getDefault(principal)).toMatchObject({ revision: 1, target: { botId: BOT, chatId: target.chatId } });
    expect(await db.selectFrom("bot_grants").selectAll().execute()).toHaveLength(0);
  });
  it("keeps native and managed Pi evidence distinct for live source validation", async () => {
    const svc = service(); await svc.remember(principal, target);
    for (const route of ["native", "managed"] as const) {
      const src = source("pi"); src.identity = { ...src.identity, kind: "chat_run", chatId: "chat_source", runId: "run_source", route };
      await svc.resolve(src, "read");
      expect(revalidateSource.mock.calls.at(-1)?.[0]).toEqual(src);
    }
  });
  it.each(["terminal_launch", "bot_child"] as const)("accepts separate %s provenance only after live validation", async kind => {
    const svc = service(); await svc.remember(principal, target);
    const src = source(); src.identity = kind === "terminal_launch"
      ? { kind, sessionId: "session_one", incarnationId: "incarnation_one", launchId: "launch_one" }
      : { kind, taskId: "task_abcdefgh", runId: "run_child", runtimeHandle: "runtime_one" };
    expect(await svc.resolve(src, "read")).toMatchObject({ botId: BOT });
    live = false; await expect(svc.resolve(src, "read")).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("requires an owner choice and never selects the first available Bot", async () => {
    await expect(service().resolve(source(), "read")).rejects.toMatchObject({ code: "target_required" });
  });
  it.each(["missing", "expired", "future", "revoked", "read", "control", "foreign owner", "foreign computer"])("rejects %s source authority despite a saved default", async problem => {
    const svc = service(); await svc.remember(principal, target);
    const src = source();
    if (problem === "expired") clock = src.expiresAt;
    if (problem === "future") src.issuedAt = at(1);
    if (problem === "revoked") live = false;
    if (problem === "read" || problem === "control") src.actions = ["propose"];
    if (problem === "foreign owner") src.ownerId = OTHER_OWNER;
    if (problem === "foreign computer") src.computerId = "computer_other";
    await expect(svc.resolve(problem === "missing" ? undefined : src, problem === "control" ? "control" : "read"))
      .rejects.toMatchObject({ code: problem === "missing" ? "source_context_required" : "permission_denied" });
  });
  it.each(["deleted Chat", "archived Chat", "shared Chat", "foreign Chat", "removed binding", "recreated binding", "archived Bot", "deleted Bot", "missing recipe", "ambiguous binding", "ACL revoked"])("fails closed for %s without choosing a replacement", async change => {
    const svc = service(); await svc.remember(principal, target);
    const bindings = createBotBindingsRepository(db);
    if (change === "deleted Chat") await db.deleteFrom("chats").where("id", "=", target.chatId).execute();
    if (change === "archived Chat") await db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", target.chatId).execute();
    if (change === "shared Chat") await db.updateTable("chats").set({ collaboration: { shared: true } }).where("id", "=", target.chatId).execute();
    if (change === "foreign Chat") await db.updateTable("chats").set({ owner_id: OTHER_OWNER }).where("id", "=", target.chatId).execute();
    if (change === "removed binding" || change === "recreated binding") await bindings.remove({ ...scope, ...target, now: at(1) });
    if (change === "recreated binding") await bindings.bindDirect({ ...scope, ...target, now: at(2) });
    if (change === "archived Bot") await agents.update({ type: "personal", ownerId: OWNER }, BOT, { baseRevision: 1, archived: true });
    if (change === "deleted Bot") await rm(join(home, "agents"), { recursive: true });
    if (change === "missing recipe") {
      const plain = await agents.create({ type: "personal", ownerId: OWNER }, { clientRequestId: "req_plain", name: "No recipe", description: "", instructions: "Read", selection: { instanceId: "codex_default", model: "test" } });
      await bindings.remove({ ...scope, ...target, now: at(1) });
      await bindings.bindDirect({ ...scope, botId: plain.id, chatId: target.chatId, now: at(2) });
      await expect(svc.remember(principal, { ...target, botId: plain.id, baseRevision: 1 })).rejects.toMatchObject({ code: "target_unavailable" });
    }
    if (change === "ambiguous binding") await bindings.bindDirect({ ownerId: OWNER, botId: "bot_abcdefgh", chatId: target.chatId, now: NOW });
    if (change === "ACL revoked") access = false;
    await expect(svc.resolve(source(), "read")).rejects.toMatchObject({ code: "target_unavailable" });
  });
  it("rechecks authority after awaited target validation and before returning", async () => {
    const svc = service(); await svc.remember(principal, target);
    canAccessTarget.mockImplementationOnce(async () => { live = false; return true; });
    await expect(svc.resolve(source(), "control")).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("rejects late expiry during awaited target validation", async () => {
    const svc = service(); await svc.remember(principal, target);
    canAccessTarget.mockImplementationOnce(async () => { clock = at(60_000); return true; });
    await expect(svc.resolve(source(), "read")).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("authorizes preference writes from the principal and configured Computer only", async () => {
    const svc = service();
    await expect(svc.remember({ ...principal, userId: OTHER_OWNER }, target)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(svc.remember(principal, { ...target, ownerId: OWNER } as never)).rejects.toMatchObject({ code: "invalid_input" });
    await svc.remember(principal, target);
    expect(await svc.reset(principal, { baseRevision: 1 })).toMatchObject({ revision: 2, target: null });
    await expect(svc.resolve(source(), "read")).rejects.toMatchObject({ code: "target_required" });
    await expect(svc.remember(principal, { ...target, baseRevision: 1 })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it.each(["deleted Chat", "shared Chat", "ACL revoked"])("lets a fresh owner recover a %s default with its stored revision only", async change => {
    await service().remember(principal, target);
    if (change === "deleted Chat") await db.deleteFrom("chats").where("id", "=", target.chatId).execute();
    if (change === "shared Chat") await db.updateTable("chats").set({ collaboration: { shared: true } }).where("id", "=", target.chatId).execute();
    if (change === "ACL revoked") access = false;
    const fresh = service();
    await expect(fresh.getDefault(principal)).rejects.toMatchObject({ code: "target_unavailable" });
    await expect(fresh.resolve(source(), "read")).rejects.toMatchObject({ code: "target_unavailable" });
    const stored = await fresh.getStoredPreference(principal);
    expect(stored).toMatchObject({ revision: 1, target: { botId: BOT, chatId: target.chatId, bindingCreatedAt: NOW } });
    await expect(fresh.getStoredPreference({ ...principal, userId: OTHER_OWNER })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(fresh.reset(principal, { baseRevision: stored.revision - 1 })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await fresh.reset(principal, { baseRevision: stored.revision })).toMatchObject({ revision: 2, target: null });
    await expect(fresh.resolve(source(), "read")).rejects.toMatchObject({ code: "target_required" });
  });
  it("can pin and revalidate in dispatch's transaction, rejecting changed preference revision", async () => {
    const svc = service(); await svc.remember(principal, target);
    const pinned = await svc.resolve(source(), "read");
    await svc.remember(principal, { ...target, baseRevision: 1 });
    await expect(db.transaction().execute(trx => svc.resolveWithin(trx, source(), "read", pinned)))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await db.transaction().execute(async trx => {
      expect(await svc.resolveWithin(trx, source(), "read")).toMatchObject({ preferenceRevision: 2 });
      await sql`SELECT 1`.execute(trx);
    });
  });
  it("fails closed when live authority/ACL dependencies are absent and maps internal errors safely", async () => {
    await service().remember(principal, target);
    const missing = createRoutineCliTargetService({ db, scope, agents, now: () => new Date(clock) });
    await expect(missing.resolve(source(), "read")).rejects.toMatchObject({ code: "unavailable" });
    revalidateSource.mockRejectedValueOnce(new Error("postgres://private-provider-credential"));
    await expect(service().resolve(source(), "read")).rejects.toMatchObject({ code: "unavailable", message: "Routine request unavailable" });
  });
});
