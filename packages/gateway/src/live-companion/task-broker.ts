import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { sql } from "kysely";
import { CanonicalChatMessageSchema, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { ChatNotFoundError, ChatConflictError, ChatBusyError } from "../chat/errors.js";
import { jsonb, parseJson } from "../chat/records.js";
import { createLiveHistory } from "./history.js";
import type { LiveCompanionPort } from "./coordinator.js";

/** A voice intent opens a separately authorized ordinary Chat task. The live
 * model never acquires a shell or extends the conversation-only media policy.
 * Child Chat + canonical source link commit together before admission. Empty
 * linked Chats are acceptable if catalog/admission fails: retry selects the
 * same Chat; accepted turns reconcile through the existing dispatcher.
 */
export function createCanonicalLivePort(options: {
  repository: ChatRepository;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn">;
  principal: RequestPrincipal;
  chatId: string;
  selection: CanonicalChatModelSelection;
  taskEvents?: import("../voice-session/ports.js").VoiceChatEventSource;
}): LiveCompanionPort {
  const { repository, principal, chatId, selection } = options;
  const owner = { type: "personal" as const, ownerId: principal.userId };
  const history = createLiveHistory(repository, owner, chatId);
  const resumeTasks: NonNullable<LiveCompanionPort["resumeTasks"]> = async () => {
    const source = await repository.get(owner, chatId);
    if (!source || source.chat.collaboration) throw new ChatNotFoundError(chatId);
    // Select bounded reference-bearing messages, not the latest conversation
    // page: a task may run across many subsequent casual voice turns.
    const linked = await sql<{ id: string }>`
      WITH linked AS (
        SELECT child.id, MAX(message.seq) AS seq
        FROM chat_messages AS message
        JOIN chats AS root ON root.id = message.chat_id
        CROSS JOIN LATERAL jsonb_array_elements(message.parts) AS part
        JOIN chats AS child ON child.id = part->'resource'->>'id'
        WHERE root.id = ${chatId} AND root.owner_type = 'personal' AND root.owner_id = ${principal.userId}
          AND root.collaboration IS NULL AND message.state = 'committed'
          AND part->>'type' = 'resource_reference' AND part->'resource'->>'kind' = 'chat'
          AND child.id LIKE 'chat_live_task_%' AND child.owner_type = root.owner_type
          AND child.owner_id = root.owner_id AND child.collaboration IS NULL
          AND child.project_id IS NOT DISTINCT FROM root.project_id
        GROUP BY child.id
      )
      SELECT linked.id FROM linked
      LEFT JOIN LATERAL (
        SELECT status FROM chat_runs WHERE chat_id = linked.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) AS latest_run ON TRUE
      ORDER BY CASE WHEN latest_run.status NOT IN ('completed', 'failed', 'aborted') THEN 0 ELSE 1 END,
        linked.seq DESC, linked.id ASC
      LIMIT 3
    `.execute(repository.kysely);
    const ids = linked.rows.map(row => row.id);
    const tasks = [];
    for (const id of ids) {
      const record = await repository.getDetailPage(owner, id, { limit: 1 });
      if (!record || record.record.chat.collaboration || record.record.projectId !== source.projectId) continue;
      const run = record.runs.at(-1);
      if (run) tasks.push({ chatId: id, runId: run.id, state: run.status === "completed" ? "succeeded" as const : run.status === "aborted" ? "cancelled" as const : run.status === "accepted" ? "queued" as const : run.status, label: record.record.chat.title });
    }
    return tasks;
  };
  return {
    ...history,
    resumeTasks,
    async status() { const tasks = await resumeTasks(); return { state: tasks.some(task => !["succeeded", "failed", "cancelled"].includes(task.state)) ? "running" : "idle", tasks }; },
    watchTask(targetId, listener) {
      if (!options.taskEvents) return () => undefined;
      let closed = false;
      let checking = false;
      let pending: import("../voice-session/ports.js").VoiceCanonicalChatEvent | null = null; // one coalesced event
      const dispose = () => { if (!closed) { closed = true; pending = null; subscription.close(); } };
      const drain = async () => {
        checking = true;
        try {
          while (!closed && pending) {
            const event = pending; pending = null;
            const [root, target] = await Promise.all([repository.get(owner, chatId), repository.get(owner, targetId)]);
            if (!root || root.chat.collaboration || !target || target.chat.collaboration || target.projectId !== root.projectId) { dispose(); return; }
            if (!closed) listener(event);
          }
        } catch (error: unknown) {
          console.warn("[live-companion] task access unavailable", error instanceof Error ? error.name : "UnknownError");
          dispose();
        } finally { checking = false; }
      };
      const subscription = options.taskEvents.subscribe({ chatId: targetId, principalId: principal.userId }, event => {
        if (closed || event.type === "assistant.text") return;
        pending = event;
        if (!checking) void drain();
      });
      return dispose;
    },
    async delegate(input) {
      const sourceId = z.string().min(1).max(160).regex(/^msg_live_[a-f0-9]{64}$/).parse(input.sourceId);
      const kind = z.enum(["build_app", "task", "open_app", "terminal"]).parse(input.kind);
      const hash = createHash("sha256").update(`${principal.userId}:${chatId}:${sourceId}:${kind}`).digest("hex");
      const targetId = `chat_live_task_${hash}`;
      const prepared = await repository.withTransaction(async repo => {
        // All voice admissions for an owner serialize reservation, including
        // different root Chats and reconnects. Empty linked Chats reserve a
        // slot until retried or explicitly deleted; admission happens later.
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`live-tasks:${principal.userId}`}, 0))`.execute(repo.kysely);
        const sourceChat = await repo.kysely.selectFrom("chats").selectAll().where("id", "=", chatId)
          .where("owner_type", "=", "personal").where("owner_id", "=", principal.userId)
          .where("collaboration", "is", null).forUpdate().executeTakeFirst();
        if (!sourceChat) throw new ChatNotFoundError(chatId);
        const source = await repo.kysely.selectFrom("chat_messages").selectAll().where("chat_id", "=", chatId)
          .where("id", "=", sourceId).where("role", "=", "user").where("state", "=", "committed").executeTakeFirst();
        if (!source) throw new ChatNotFoundError(chatId);
        const existing = await repo.get(owner, targetId);
        if (!existing) {
          const unresolved = await repo.kysely.selectFrom("chats").select("id")
            .where("owner_type", "=", "personal").where("owner_id", "=", principal.userId)
            .where("id", "like", "chat_live_task_%")
            .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM chat_runs WHERE chat_runs.chat_id = chats.id) OR EXISTS (SELECT 1 FROM chat_runs WHERE chat_runs.chat_id = chats.id AND chat_runs.status NOT IN ('completed', 'failed', 'aborted'))`)
            .limit(3).execute();
          if (unresolved.length >= 3) throw new ChatBusyError(chatId);
        }
        // Only the authenticated finalized utterance drives effects. A live
        // model's proposed prompt cannot add authorization or a new command.
        const instruction = source.search_text;
        const record = await repo.create(owner, { id: targetId, clientRequestId: `req_live_task_${hash}`,
          title: `${kind === "build_app" ? "Build" : "Task"}: ${instruction}`.slice(0, 160),
          ...(sourceChat.project_id ? { projectId: sourceChat.project_id } : {}), currentSelection: selection });
        const message = CanonicalChatMessageSchema.parse({ id: source.id, chatId, seq: source.seq, role: "user", state: "committed", actorId: principal.userId, purpose: "discussion", createdAt: new Date(source.created_at).toISOString(), parts: parseJson(source.parts) });
        if (!message.parts.some(p => p.type === "resource_reference" && p.resource.id === targetId)) {
          message.parts.push({ type: "resource_reference", resource: { kind: "chat", id: targetId, label: record.chat.title } });
          CanonicalChatMessageSchema.parse(message);
          await repo.kysely.updateTable("chat_messages").set({ parts: jsonb(message.parts) }).where("id", "=", sourceId).where("chat_id", "=", chatId).execute();
          const updated = await repo.kysely.updateTable("chats").set({ revision: Number(sourceChat.revision) + 1 }).where("id", "=", chatId).where("revision", "=", sourceChat.revision).returning("revision").executeTakeFirst();
          if (!updated) throw new ChatConflictError(chatId, Number(sourceChat.revision));
          await repo.appendOutboxEvent(owner, chatId, Number(updated.revision), "chat.updated");
        }
        return { record, instruction };
      });
      const prefix = kind === "build_app" ? "Build an app through the existing builder agent and matrix-app-builder skill. Verify the build, manifest and real launcher before declaring the app ready. User request: " : "User request: ";
      const admitted = await options.orchestrator.admitTurn(principal, owner, targetId, {
        clientRequestId: `req_live_action_${hash}`, baseRevision: prepared.record.chat.revision,
        selection: prepared.record.chat.currentSelection ?? selection, interactionMode: "default", permissionMode: "supervised",
        parts: [{ type: "text", text: prefix + prepared.instruction }],
      });
      return { outcome: admitted.admission === "already_accepted" ? "already_accepted" : "sent", chatId: targetId,
        canonicalTurnId: admitted.turn.id, runId: admitted.run.id, revision: Number(admitted.record.chat.revision),
        state: admitted.run.status === "completed" ? "succeeded" : admitted.run.status === "aborted" ? "cancelled" : admitted.run.status === "accepted" ? "queued" : admitted.run.status };
    },
  };
}
