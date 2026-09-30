import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createPrivateBotAdmission, privateBotScopeHandle, type PrivateBotRunRequest } from "../../../packages/gateway/src/bots/admission.js";
import { BotRuntimeRegistry, type GroupBotAuthorizer } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_group1";
const RUNTIME = `runtime_${"c".repeat(32)}`;
const root = { ref: { kind: "project" as const, projectId: "project_company1" }, fingerprint: "f".repeat(64), primaryWorkspaceRoot: "/company/shared-root" };
const request: PrivateBotRunRequest = {
  ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: "task_0123456789abcdef", runId: "run_group1",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 4096 },
  accessSourceId: "matrix_included", capabilities: [], requestClass: "interactive",
  group: { scopeId: "company-scope", actorId: "user_member", executionRoot: root.ref, executionRootFingerprint: root.fingerprint, sessionGeneration: "1" },
};
const context = {
  actorId: "user_member", ownerId: OWNER, organizationId: "org_company", scopeId: "company-scope", membershipScopeId: "company-scope",
  resourceKind: "chat" as const, resourceId: CHAT, role: "editor" as const, authEpoch: 2, authorityRuntimeId: "owner_runtime", authorityGeneration: 3,
  capability: "request_ai" as const,
};
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: CHAT, kind: "group", created_at: NOW, removed_at: null }).execute();
});
afterEach(async () => destroy());
function setup(authorizeGroup?: GroupBotAuthorizer, duringLaunch?: () => void) {
  const registry = new BotRuntimeRegistry();
  const roots = { resolve: vi.fn(async () => root) };
  const client = { createRuntime: vi.fn(async (_input: unknown) => { duringLaunch?.(); return { runtimeHandle: RUNTIME, executionGeneration: "1" }; }), stopRuntime: vi.fn(async () => undefined) };
  const admission = createPrivateBotAdmission({ db, registry, roots, host: { available: true, client: client as never }, authorizeGroup });
  return { admission, registry, roots, client };
}
describe("shared group Pi admission", () => {
  it("requires fresh exact collaboration authorization and never uses the private workspace", async () => {
    const authorize = vi.fn(async () => context);
    const { admission, roots, client, registry } = setup(authorize);
    await admission.admit(request);
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(roots.resolve).toHaveBeenCalledWith({ type: "personal", ownerId: OWNER }, root.ref);
    const launch = client.createRuntime.mock.calls[0]![0] as never as { scopeHandle: string; sandbox: { actorId: string; worktree: { hostPath: string } } };
    expect(launch.scopeHandle).not.toBe(privateBotScopeHandle(OWNER, BOT));
    expect(launch.sandbox).toMatchObject({ actorId: "user_member", worktree: { hostPath: root.primaryWorkspaceRoot } });
    expect(registry.lookup({ runtimeHandle: RUNTIME, executionGeneration: "1" })).toMatchObject({ group: { authEpoch: 2, actorId: "user_member" } });
  });
  it("fails closed on absent authority, wrong actor/scope/chat/owner, and private capabilities/root", async () => {
    for (const authorize of [undefined, async () => ({ ...context, actorId: "intruder" }), async () => ({ ...context, scopeId: "other" }), async () => ({ ...context, resourceId: "chat_other" }), async () => ({ ...context, ownerId: "other-owner" })]) {
      const { admission, client } = setup(authorize);
      await expect(admission.admit(request)).rejects.toMatchObject({ code: "not_found" });
      expect(client.createRuntime).not.toHaveBeenCalled();
    }
    const { admission, client } = setup(async () => context);
    await expect(admission.admit({ ...request, capabilities: ["artifact.read"] })).rejects.toMatchObject({ code: "not_found" });
    await expect(admission.admit({ ...request, group: { ...request.group!, executionRoot: { kind: "bot_workspace", botId: BOT } } as never })).rejects.toMatchObject({ code: "invalid_root" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });
  it("refuses stale canonical group root provenance before launch", async () => {
    const { admission, client } = setup(async () => context);
    await expect(admission.admit({ ...request, group: { ...request.group!, executionRootFingerprint: "b".repeat(64) } })).rejects.toMatchObject({ code: "root_changed" });
    expect(client.createRuntime).not.toHaveBeenCalled();
  });
  it("stops the new runtime if authority changes while launch waits", async () => {
    let epoch = 2;
    const { admission, client, registry } = setup(async () => ({ ...context, authEpoch: epoch }), () => { epoch += 1; });
    await expect(admission.admit(request)).rejects.toThrow("authority changed");
    expect(client.stopRuntime).toHaveBeenCalledWith({ runtimeHandle: RUNTIME });
    expect(registry.size).toBe(0);
  });
});
