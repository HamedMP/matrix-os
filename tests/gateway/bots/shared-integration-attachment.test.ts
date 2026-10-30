import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BotToolResultSchema } from "@matrix-os/contracts";
import { createBotWorkspace } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createSharedAttachmentSource } from "../../../packages/gateway/src/bots/shared-integration-attachment.js";
import type { GroupBotRunRequest } from "../../../packages/gateway/src/bots/admission.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotIntegrationClient } from "../../../packages/gateway/src/bots/integration-client.js";
import type { BotExecutor } from "../../../packages/gateway/src/bots/repositories/shared.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_shared_attachment";
const connection = { service: "gmail", connectionId: "conn_work", label: "Work" };
const request = { service: "gmail", action: "get_attachment", connectionId: connection.connectionId,
  params: { messageId: "mail_1", attachmentId: "part_1" } };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let state: Awaited<ReturnType<typeof createBotStateDatabase>>;
let home: string;
let project: string;
let privateRoot: string;
let binding: BotRuntimeBinding;
let bytes: Buffer;
let assertSource: Mock<(binding: BotRuntimeBinding, signal?: AbortSignal, executor?: BotExecutor) => Promise<void>>;
let assertSharedAttachmentSource: Mock<(binding: BotRuntimeBinding, signal: AbortSignal) => Promise<void>>;
let call: Mock<BotIntegrationClient["call"]>;
let resolveGroupRun: Mock<(input: { ownerId: string; chatId: string; runId: string }) => Promise<GroupBotRunRequest>>;
let canonical: GroupBotRunRequest;
let projectRecord: { id: string; slug: string; localPath: string };

beforeEach(async () => {
  state = await createBotStateDatabase();
  await insertChat(state.db, CHAT);
  const task = await createBotTasksRepository(state.db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  home = await realpath(await mkdtemp(join(tmpdir(), "matrix-shared-gmail-")));
  project = join(home, "projects", "company"); await mkdir(project, { recursive: true });
  privateRoot = await createBotWorkspace({ homePath: home, botId: BOT });
  await writeFile(join(privateRoot, "private.txt"), "Private owner context");
  projectRecord = { id: "proj_company", slug: "company", localPath: project };
  const roots = createChatExecutionRootResolver({ homePath: home,
    projects: { getProjectById: async () => ({ ok: true, project: projectRecord }),
      resolveProjectWorkingDirectory: async () => projectRecord.localPath },
    worktrees: { getWorktree: async () => ({ ok: false, status: 404, error: "absent" }) } });
  const root = await roots.resolve({ type: "personal", ownerId: OWNER }, { kind: "project", projectId: "proj_company" });
  binding = { runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT,
    chatId: CHAT, taskId: task.taskId, runId: "run_shared_attachment", rootFingerprint: root.fingerprint,
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8192 },
    accessSourceId: "matrix_included", capabilities: ["integration.inventory", "integration.call"], requestClass: "interactive",
    group: { scopeId: "scope_company", actorId: "user_member", authEpoch: 1, authorityGeneration: 1,
      authorityRuntimeId: "runtime_owner", sessionGeneration: "1" } };
  await createBotGrantsRepository(state.db).grant({ ownerId: OWNER, botId: BOT, ...connection,
    accountLabel: connection.label, effects: ["read"], audience: `group:${CHAT}`, grantedByActorId: OWNER, now: NOW });
  bytes = Buffer.from("Approved attachment contents");
  call = vi.fn(async () => ({ data: { size: bytes.length, data: bytes.toString("base64url") } }));
  assertSource = vi.fn(async () => {});
  canonical = { scopeId: binding.group!.scopeId, actorId: binding.group!.actorId, sessionGeneration: "1",
    executionRoot: { kind: "project", projectId: "proj_company" }, executionRootFingerprint: root.fingerprint };
  resolveGroupRun = vi.fn(async () => canonical);
  assertSharedAttachmentSource = vi.fn(createSharedAttachmentSource({ roots, group: { resolveGroupRun } }));
});
afterEach(async () => { await state.destroy(); await rm(home, { recursive: true, force: true }); });

function tools(overrides: Record<string, unknown> = {}) {
  return createBotIntegrationTools({ client: { inventory: async () => [connection], call,
      describe: async () => [], connect: async () => { throw new Error("Unexpected fixture connection"); }, sync: async () => undefined,
      callImportRead: async () => { throw new Error("Unexpected fixture import"); },
      callAppAction: async () => { throw new Error("Unexpected fixture app action"); },
    }, homePath: home,
    transact: createBotStateTransactions(new ChatRepository(state.db as unknown as Kysely<ChatDatabase>)),
    recipes: createBotRecipeCatalog(), agents: { get: async () => ({ id: BOT, recipeRef: { recipeId: "company-brain", version: "2026-09-30.1" } }) as never },
    now: () => new Date(NOW), assertSource, assertSharedAttachmentSource, ...overrides });
}
function chunk(result: unknown) {
  const parsed = BotToolResultSchema.parse(result);
  expect(parsed.ok).toBe(true); if (!parsed.ok) throw new Error("Missing attachment");
  expect(Buffer.byteLength(JSON.stringify(parsed), "utf8")).toBeLessThanOrEqual(60 * 1024);
  return JSON.parse(parsed.content.map(part => part.text).join(""));
}

describe("exact-Chat shared Gmail attachment reads", () => {
  it("reads an approved attachment with a real Project fingerprint without private artifacts", async () => {
    const result = chunk(await tools().call(binding, request));
    expect(result).toMatchObject({ kind: "integration_attachment_chunk", encoding: "base64", size: bytes.length,
      offset: 0, nextOffset: bytes.length, eof: true, sha256: digest(bytes), untrusted: true });
    expect(Buffer.from(result.data, "base64")).toEqual(bytes);
    expect(await readdir(project)).toEqual([]);
    expect(await readdir(privateRoot)).toEqual(["private.txt"]);
    expect(await readFile(join(privateRoot, "private.txt"), "utf8")).toBe("Private owner context");
    expect(binding.capabilities).not.toContain("artifact.read");
    // Both before transport and before exposing bytes: source checks share the locked executor.
    expect(assertSource.mock.calls).toHaveLength(4);
    const executors = assertSource.mock.calls.map(([, , executor]) => executor);
    expect(executors.map(executor => executor?.isTransaction ?? false)).toEqual([false, true, false, true]);

  });

  it("reconstructs the entire 1MiB attachment through bounded existing integration calls", async () => {
    bytes = Buffer.alloc(1024 * 1024, 0x81);
    const reader = tools(); const chunks: Buffer[] = []; let next: unknown;
    do {
      const result = chunk(await reader.call(binding, { ...request, params: { ...request.params, ...(next ? { chunk: next } : {}) } }));
      expect(result.sha256).toBe(digest(bytes));
      const decoded = Buffer.from(result.data, "base64"); expect(decoded.length).toBeLessThanOrEqual(32 * 1024);
      chunks.push(decoded); next = result.next;
      expect(result.eof).toBe(result.nextOffset === bytes.length);
    } while (next);
    expect(Buffer.concat(chunks)).toEqual(bytes); expect(call).toHaveBeenCalledTimes(32);
    for (const [, args] of call.mock.calls) expect(args).toMatchObject({ params: request.params, read: true });
    for (const [, args] of call.mock.calls) expect(args.params).not.toHaveProperty("chunk");
    expect(await readdir(project)).toEqual([]); expect(await readdir(privateRoot)).toEqual(["private.txt"]);
    expect(resolveGroupRun).toHaveBeenCalledWith({ ownerId: OWNER, chatId: CHAT, runId: binding.runId });
  });

  it.each(["other-chat", "other-owner"])("refuses %s grants before downloading", async (change) => {
    const foreign = change === "other-chat" ? { ...binding, chatId: "chat_other" } : { ...binding, ownerId: "user_other" };
    await expect(tools().call(foreign, request)).rejects.toMatchObject({ code: "not_granted" });
    expect(call).not.toHaveBeenCalled();
  });

  it("requires the canonical source resolver before downloading", async () => {
    await expect(tools({ assertSharedAttachmentSource: undefined }).call(binding, request)).rejects.toMatchObject({ code: "unavailable" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["grant", "source", "generation", "root", "membership", "abort"])("exposes no bytes after %s changes during the provider read", async (change) => {
    const abort = new AbortController();
    call.mockImplementationOnce(async () => {
      if (change === "grant") await state.db.updateTable("bot_grants").set({ revoked_at: NOW }).execute();
      if (change === "source") assertSource.mockRejectedValue(new BotBrokerActionError("denied"));
      if (change === "generation") canonical = { ...canonical, sessionGeneration: "2" };
      if (change === "root") { const target = join(home, "projects", "replacement"); await mkdir(target); projectRecord = { ...projectRecord, localPath: target }; }
      if (change === "membership") resolveGroupRun.mockRejectedValue(new BotBrokerActionError("denied"));
      if (change === "abort") abort.abort();
      return { data: { size: bytes.length, data: bytes.toString("base64url") } };
    });
    await expect(tools().call(binding, request, abort.signal)).rejects.toMatchObject({ code: expect.stringMatching(/^(not_granted|denied|stale_generation|timeout)$/) });
    expect(call).toHaveBeenCalledOnce(); expect(await readdir(project)).toEqual([]);
  });

  it("reauthorizes every continuation and refuses changed attachment versions", async () => {
    bytes = Buffer.alloc(40_000, 0x81); const reader = tools();
    const first = chunk(await reader.call(binding, request)); bytes = Buffer.alloc(40_000, 0x82);
    await expect(reader.call(binding, { ...request, params: { ...request.params, chunk: first.next } })).rejects.toMatchObject({ code: "stale_generation" });
    expect(call).toHaveBeenCalledTimes(2);
    await state.db.updateTable("bot_grants").set({ revoked_at: NOW }).execute();
    await expect(reader.call(binding, { ...request, params: { ...request.params, chunk: first.next } })).rejects.toMatchObject({ code: "not_granted" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each([
    null, { offset: 1, length: 1 }, { offset: -1, length: 1 }, { offset: 0.5, length: 1 },
    { offset: 1048577, length: 1 }, { offset: 0, length: 32769 }, { offset: 0, length: 0 },
    { offset: 0, length: 1, sha256: "wrong" }, { offset: 0, length: 1, path: "private.txt" },
  ])("rejects invalid local chunk metadata %# before downloading", async (selected) => {
    await expect(tools().call(binding, { ...request, params: { ...request.params, chunk: selected } })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects unknown provider parameters before downloading", async () => {
    await expect(tools().call(binding, { ...request, params: { ...request.params, path: "private.txt" } })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([{ size: 1, data: "YR" }, { size: 2, data: "YQ" }, { size: 1, data: "!!!!" },
    { size: 1048577, data: "" }, { size: 0, data: "", path: "private.txt" }])("rejects malformed provider payload %# without partial output or files", async (data) => {
    call.mockResolvedValueOnce({ data });
    await expect(tools().call(binding, request)).rejects.toMatchObject({ code: "unavailable" });
    expect(await readdir(project)).toEqual([]); expect(await readdir(privateRoot)).toEqual(["private.txt"]);
  });

  it("handles empty files and an exact EOF offset without inventing bytes", async () => {
    bytes = Buffer.alloc(0); expect(chunk(await tools().call(binding, request))).toMatchObject({ data: "", size: 0, eof: true, nextOffset: 0 });
    bytes = Buffer.from("abc");
    expect(chunk(await tools().call(binding, { ...request, params: { ...request.params, chunk: { offset: 3, length: 1, sha256: digest(bytes) } } }))).toMatchObject({ data: "", eof: true, offset: 3 });
    await expect(tools().call(binding, { ...request, params: { ...request.params, chunk: { offset: 4, length: 1, sha256: digest(bytes) } } })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("aborts a canonical resolver that does not settle without contacting the provider", async () => {
    const abort = new AbortController();
    resolveGroupRun.mockImplementationOnce(() => { abort.abort(); return new Promise(() => {}); });
    await expect(tools().call(binding, request, abort.signal)).rejects.toMatchObject({ code: "timeout" });
    expect(call).not.toHaveBeenCalled();
  });
});
