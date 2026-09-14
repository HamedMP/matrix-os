import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalChatRunSchema, CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";
import { createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_checkpoint" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const chatId = "chat_checkpoint";
const selection = { instanceId: "claude_default", model: "sonnet" };
const catalog = CanonicalProviderCatalogSchema.parse({
  revision: "checkpoint_catalog",
  drivers: [{ kind: "claude_code", displayName: "Claude", adapterVersion: "1.0.0", capabilityClass: "coding_agent" }],
  instances: [{
    id: selection.instanceId, driverKind: "claude_code", displayName: "Claude", availability: "available",
    workspaceRequirement: "project_optional", catalogRevision: "checkpoint_catalog",
    models: [{ id: selection.model, displayName: "Sonnet", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false }],
    options: [], skills: [], commands: [], setupActions: [],
    supports: {
      rootChat: true, resume: true, cancellation: true, steering: "same_run", attachments: [], tools: [],
      approvals: false, userInput: false, worktrees: "optional", resources: [],
      interactionModes: ["default"], permissionModes: ["supervised"],
    },
  }],
});

let repository: ChatRepository;
let orchestrator: CanonicalChatOrchestrator;
let homePath: string;
let projectFingerprint: string;
const projectRef = { kind: "project" as const, projectId: "project_checkpoint" };
beforeEach(async () => {
  const database = await KyselyPGlite.create();
  repository = new ChatRepository(database.dialect);
  await repository.bootstrap();
  await repository.create(owner, { id: chatId, clientRequestId: "req_create_checkpoint", title: "Continuity" });
  homePath = await mkdtemp(join(tmpdir(), "matrix-checkpoint-"));
  const roots = createChatExecutionRootResolver({
    homePath,
    projects: {
      getProjectById: async () => ({ ok: true as const, project: { id: projectRef.projectId, slug: "checkpoint", localPath: homePath } }),
      resolveProjectWorkingDirectory: async () => homePath,
    },
    worktrees: { getWorktree: async () => ({ ok: false as const, status: 404, error: "unused" }) },
  });
  projectFingerprint = (await roots.resolve(owner, projectRef)).fingerprint;
  const adapter = createClaudeChatProviderAdapter({
    homePath, resolveCredentialEnv: async () => ({}),
    spawnFn(_command, args) {
      const resumed = args.indexOf("--resume");
      const sessionId = resumed < 0 ? "native_empty" : args[resumed + 1];
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill() { queueMicrotask(() => child.emit("exit", null, "SIGTERM")); return true; },
      });
      queueMicrotask(() => {
        // The external CLI fixture reports which native conversation it opened.
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({
          type: "result", subtype: "success", result: `RESUMED ${sessionId}`,
        })}\n`));
        child.emit("exit", 0, null);
      });
      return child;
    },
  });
  orchestrator = new CanonicalChatOrchestrator({
    repository, catalog: { getCatalog: async () => catalog },
    adapters: new CanonicalChatProviderRegistry([adapter]),
    executionRoots: roots,
  });
});
afterEach(async () => {
  await orchestrator.close();
  await repository.kysely.destroy();
  await rm(homePath, { recursive: true, force: true });
});

// Historical checkpoints are admitted through the repository's public API,
// as they would be by an older adapter version; no database rows are patched.
async function checkpoint(input: {
  schemaVersion: number; sessionId: string; outcome: "completed" | "failed" | "aborted";
  executionRootFingerprint?: string;
  deferCompletion?: boolean;
}) {
  const record = (await repository.get(owner, chatId))!.chat;
  const seq = record.messageCount + 1;
  const timestamp = new Date(Date.UTC(2026, 8, 9, 0, 0, seq)).toISOString();
  const message = {
    id: `msg_checkpoint_${seq}`, chatId, seq, role: "user" as const, state: "committed" as const,
    turnId: `cturn_checkpoint_${seq}`, parts: [{ type: "text" as const, text: "Remember the marker" }], createdAt: timestamp,
  };
  const turn = {
    id: message.turnId, chatId, clientRequestId: `req_checkpoint_${seq}`, baseMessageSeq: seq - 1,
    inputMessageId: message.id, status: "accepted" as const, createdAt: timestamp, updatedAt: timestamp,
  };
  const run = CanonicalChatRunSchema.parse({
    id: `run_checkpoint_${seq}`, chatId, turnId: turn.id, attempt: 1, driverKind: "claude_code",
    instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "supervised",
    status: "accepted", historyBoundarySeq: seq - 1,
    ...(input.executionRootFingerprint ? {
      executionRoot: projectRef,
      executionRootFingerprint: input.executionRootFingerprint,
    } : {}),
    capabilitySnapshot: { ...catalog.instances[0].supports, revision: catalog.revision },
    createdAt: timestamp, updatedAt: timestamp,
  });
  await repository.admitTurn(owner, {
    chatId, baseRevision: record.revision, message, turn, run,
    adapterState: { schemaVersion: input.schemaVersion, state: { sessionId: input.sessionId } },
  });
  const finish = () => repository.finishRun(owner, { chatId, runId: run.id, outcome: input.outcome, completedAt: timestamp });
  if (!input.deferCompletion) await finish();
  return { turn, finish };
}

const cases = (["schema", "root"] as const).flatMap((mismatch) => (
  (["failed", "aborted"] as const).flatMap((outcome) => (
    [false, true].flatMap((queued) => [false, true].map((project) => ({ mismatch, outcome, queued, project })))
  ))
));
it.each(cases)("resumes past incompatible $outcome $mismatch checkpoint (queued=$queued, project=$project)", async ({ mismatch, outcome, queued, project }) => {
  const root = project ? { executionRootFingerprint: projectFingerprint } : {};
  await checkpoint({ schemaVersion: 1, sessionId: "native_compatible", outcome: "completed", ...root });
  const interrupted = await checkpoint({
    schemaVersion: mismatch === "schema" ? 2 : 1, sessionId: "native_incompatible", outcome,
    ...(mismatch === "root" ? { executionRootFingerprint: "a".repeat(64) } : root),
    deferCompletion: queued,
  });
  const record = (await repository.get(owner, chatId))!.chat;
  const request = {
    baseRevision: record.revision, clientRequestId: "req_followup_checkpoint",
    parts: [{ type: "text" as const, text: "Recall the marker" }], selection,
    interactionMode: "default", permissionMode: "supervised",
    ...(project ? { executionRoot: projectRef } : {}),
  };
  if (queued) {
    await orchestrator.enqueueQueuedTurn(principal, owner, chatId, request);
    await interrupted.finish();
    await orchestrator.reconcileActiveRuns(owner);
  } else {
    await orchestrator.admitTurn(principal, owner, chatId, request);
  }
  await orchestrator.drain();
  const history = await repository.exportChat(owner, chatId);
  expect(history?.runs.at(-1)?.status).toBe("completed");
  expect(history?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "RESUMED native_compatible" }]);
});

it.each(["failed", "aborted"] as const)("Retry excludes even a compatible %s checkpoint", async (outcome) => {
  await checkpoint({ schemaVersion: 1, sessionId: "native_completed", outcome: "completed" });
  const interrupted = await checkpoint({ schemaVersion: 1, sessionId: "native_interrupted", outcome });
  const record = (await repository.get(owner, chatId))!.chat;
  await orchestrator.retryTurn(principal, owner, chatId, interrupted.turn.id, {
    baseRevision: record.revision, clientRequestId: "req_retry_checkpoint",
  });
  await orchestrator.drain();
  expect((await repository.exportChat(owner, chatId))?.messages.at(-1)?.parts)
    .toEqual([{ type: "text", text: "RESUMED native_completed" }]);
});

it.each(["schema", "root"] as const)("does not resume across a %s boundary when no compatible checkpoint exists", async (mismatch) => {
  await checkpoint({
    schemaVersion: mismatch === "schema" ? 2 : 1, sessionId: "native_incompatible", outcome: "failed",
    ...(mismatch === "root" ? { executionRootFingerprint: "a".repeat(64) } : {}),
  });
  const record = (await repository.get(owner, chatId))!.chat;
  await orchestrator.admitTurn(principal, owner, chatId, {
    baseRevision: record.revision, clientRequestId: "req_no_checkpoint",
    parts: [{ type: "text", text: "New conversation" }], selection,
    interactionMode: "default", permissionMode: "supervised",
  });
  await orchestrator.drain();
  expect((await repository.exportChat(owner, chatId))?.messages.at(-1)?.parts)
    .toEqual([{ type: "text", text: "RESUMED native_empty" }]);
});
