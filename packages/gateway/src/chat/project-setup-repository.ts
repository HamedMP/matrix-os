import { createHash, randomUUID } from "node:crypto";
import { ProjectSetupDraftSchema, type ProjectSetupDraft, type ProjectSetupStartRequest, type ProjectSetupUpdateRequest, type ProjectSetupResponse } from "@matrix-os/contracts";
import { jsonb, parseJson, type ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { beginProjectSetupInterview, initialProjectSetup, ProjectSetupError, PROJECT_SETUP_INTERVIEW_START, PROJECT_SETUP_QUESTIONS } from "./project-setup-state.js";
import type { SetupTranscriptMessage } from "./project-setup-transcript.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type SetupMutation = Omit<ProjectSetupUpdateRequest, "action"> & {
  action: ProjectSetupUpdateRequest["action"] | { type: "resume_interview" };
  originalRequest?: ProjectSetupStartRequest;
};
type SetupTransition = { draft: ProjectSetupDraft; userText?: string; assistantText?: string; keepAnchor?: boolean };

export class ProjectSetupRepository {
  constructor(private readonly chats: ChatRepository) {}

  async getByProject(owner: ChatOwner, projectId: string, fingerprint: string): Promise<ProjectSetupDraft | null> {
    if (owner.type !== "personal") throw new ProjectSetupError("not_found");
    const row = await this.chats.kysely.selectFrom("chat_project_setups as setup").innerJoin("chats", "chats.id", "setup.chat_id")
      .select("setup.draft").where("setup.owner_id", "=", owner.ownerId).where("setup.project_id", "=", projectId).where("setup.root_fingerprint", "=", fingerprint)
      .where("chats.owner_type", "=", "personal").where("chats.owner_id", "=", owner.ownerId).where("chats.project_id", "=", projectId)
      .where("chats.lifecycle", "=", "active").where("chats.collaboration", "is", null).executeTakeFirst();
    return row ? ProjectSetupDraftSchema.parse(parseJson(row.draft)) : null;
  }

  async getByChat(owner: ChatOwner, chatId: string, fingerprint: string): Promise<ProjectSetupDraft> {
    const row = await this.chats.kysely.selectFrom("chat_project_setups").selectAll().where("owner_id", "=", owner.ownerId).where("chat_id", "=", chatId)
      .where("root_fingerprint", "=", fingerprint).executeTakeFirst();
    const record = await this.chats.get(owner, chatId);
    if (owner.type !== "personal" || !row || !record || record.projectId !== row.project_id || record.chat.lifecycle !== "active" || record.chat.collaboration) throw new ProjectSetupError("not_found");
    return ProjectSetupDraftSchema.parse(parseJson(row.draft));
  }

  async start(owner: ChatOwner, projectId: string, fingerprint: string,
    input: ProjectSetupStartRequest): Promise<ProjectSetupResponse & { admissionPending?: boolean }> {
    if (owner.type !== "personal") throw new ProjectSetupError("not_found");
    return this.chats.withTransaction(async repository => {
      const db = repository.kysely;
      await db.insertInto("chat_project_setups").values({ owner_id: owner.ownerId, project_id: projectId, root_fingerprint: fingerprint,
        chat_id: null, revision: 0, draft: jsonb({}), last_request_id: input.clientRequestId, last_request_hash: hash(input), updated_at: new Date().toISOString() })
        .onConflict(conflict => conflict.columns(["owner_id", "project_id", "root_fingerprint"]).doNothing()).execute();
      const row = await db.selectFrom("chat_project_setups").selectAll().where("owner_id", "=", owner.ownerId).where("project_id", "=", projectId)
        .where("root_fingerprint", "=", fingerprint).forUpdate().executeTakeFirstOrThrow();
      const interview = "mode" in input;
      if (row.chat_id) {
        const record = await repository.get(owner, row.chat_id);
        if (!record || record.projectId !== projectId || record.chat.lifecycle !== "active" || record.chat.collaboration) throw new ProjectSetupError("not_found");
        const draft = ProjectSetupDraftSchema.parse(parseJson(row.draft));
        if ((!interview && draft.interview) || (row.last_request_id === input.clientRequestId && row.last_request_hash !== hash(input))) {
          throw new ProjectSetupError("conflict");
        }
        return { draft, record, ...(interview && draft.interview && draft.generation?.status === "pending"
          && row.last_request_id === input.clientRequestId ? { admissionPending: true } : {}) };
      }
      const chatId = `chat_${randomUUID().replaceAll("-", "")}`;
      await repository.create(owner, { id: chatId, clientRequestId: input.clientRequestId, title: "Project setup", projectId,
        ...(input.currentSelection ? { currentSelection: input.currentSelection } : {}) });
      const questionId = `msg_${randomUUID().replaceAll("-", "")}`;
      const draft = interview
        ? beginProjectSetupInterview({ chatId, projectId, revision: 0, step: "guidance", currentQuestionMessageId: questionId,
          answers: { purpose: "" }, proposals: [], mcp: { state: "not_requested" }, updatedAt: new Date().toISOString() })
        : initialProjectSetup(chatId, projectId, input.answer, questionId);
      await repository.appendProjectSetupMessages(owner, chatId, interview
        ? [{ role: "user", text: PROJECT_SETUP_INTERVIEW_START, id: questionId }]
        : [{ role: "user", text: input.answer }, { role: "assistant", text: PROJECT_SETUP_QUESTIONS.guidance, id: questionId }]);
      await db.updateTable("chat_project_setups").set({ chat_id: chatId, draft: jsonb(draft) }).where("owner_id", "=", owner.ownerId).where("project_id", "=", projectId)
        .where("root_fingerprint", "=", fingerprint).where("revision", "=", 0).execute();
      return { draft, record: (await repository.get(owner, chatId))!, ...(interview ? { admissionPending: true } : {}) };
    });
  }

  async linkGeneration(owner: ChatOwner, chatId: string, fingerprint: string, requestId: string,
    generation: NonNullable<ProjectSetupDraft["generation"]>): Promise<ProjectSetupDraft> {
    return this.chats.withTransaction(async repository => {
      const db = repository.kysely;
      const chat = await db.selectFrom("chats").selectAll().where("id", "=", chatId)
        .where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId).forUpdate().executeTakeFirst();
      if (!chat || owner.type !== "personal" || chat.lifecycle !== "active" || chat.collaboration !== null) throw new ProjectSetupError("not_found");
      const row = await db.selectFrom("chat_project_setups").selectAll().where("owner_id", "=", owner.ownerId).where("chat_id", "=", chatId)
        .where("root_fingerprint", "=", fingerprint).forUpdate().executeTakeFirst();
      if (!row || row.project_id !== chat.project_id) throw new ProjectSetupError("not_found");
      const draft = ProjectSetupDraftSchema.parse(parseJson(row.draft));
      if (row.last_request_id !== requestId) {
        if (generation.runId && draft.generation?.runId === generation.runId
          && draft.generation.sourceRevision === generation.sourceRevision) return draft;
        throw new ProjectSetupError("conflict");
      }
      if (draft.generation?.status !== "pending") return draft;
      const next = ProjectSetupDraftSchema.parse({ ...draft, generation });
      await db.updateTable("chat_project_setups").set({ draft: jsonb(next) }).where("owner_id", "=", owner.ownerId).where("chat_id", "=", chatId)
        .where("revision", "=", draft.revision).where("last_request_id", "=", requestId).execute();
      await repository.appendProjectSetupMessages(owner, chatId, []);
      return next;
    });
  }

  async mutate(owner: ChatOwner, chatId: string, fingerprint: string, input: SetupMutation,
    operation: (draft: ProjectSetupDraft, repository: ChatRepository, lastRequestId: string | null) => Promise<SetupTransition> | SetupTransition): Promise<ProjectSetupResponse> {
    return this.chats.withTransaction(async repository => {
      const db = repository.kysely;
      const chat = await db.selectFrom("chats").selectAll().where("id", "=", chatId).where("owner_type", "=", owner.type).where("owner_id", "=", owner.ownerId).forUpdate().executeTakeFirst();
      if (!chat || owner.type !== "personal" || chat.lifecycle !== "active" || chat.collaboration !== null) throw new ProjectSetupError("not_found");
      const row = await db.selectFrom("chat_project_setups").selectAll().where("chat_id", "=", chatId).where("owner_id", "=", owner.ownerId)
        .where("root_fingerprint", "=", fingerprint).forUpdate().executeTakeFirst();
      if (!row || row.project_id !== chat.project_id) throw new ProjectSetupError("not_found");
      const current = ProjectSetupDraftSchema.parse(parseJson(row.draft));
      const requestHash = hash(input.originalRequest ?? input);
      if (row.last_request_id === input.clientRequestId) {
        if (row.last_request_hash !== requestHash) throw new ProjectSetupError("conflict");
        return { draft: current, record: (await repository.get(owner, chatId))! };
      }
      const revision = Number(row.revision);
      if (revision !== input.baseRevision) {
        if (input.action.type === "sync_generation" && input.baseRevision < revision) {
          return { draft: current, record: (await repository.get(owner, chatId))! };
        }
        throw new ProjectSetupError("conflict");
      }
      if (current.interview && current.generation?.status === "pending" && input.action.type !== "sync_generation") throw new ProjectSetupError("busy");
      const recordBeforeAction = await repository.get(owner, chatId);
      if (recordBeforeAction?.activeRun && input.action.type !== "sync_generation") throw new ProjectSetupError("busy");
      const result = await operation(current, repository, row.last_request_id);
      if (current === result.draft && !result.userText && !result.assistantText) return { draft: current, record: recordBeforeAction! };
      const entries: SetupTranscriptMessage[] = [
        ...(result.userText ? [{ role: "user" as const, text: result.userText }] : []),
        ...(result.assistantText ? [{ role: "assistant" as const, text: result.assistantText,
          ...(!result.userText ? { anchorMessageId: current.currentQuestionMessageId } : {}) }] : []),
      ];
      const messageId = await repository.appendProjectSetupMessages(owner, chatId, entries);
      const draft = ProjectSetupDraftSchema.parse({ ...result.draft, ...(messageId && !result.keepAnchor ? { currentQuestionMessageId: messageId } : {}),
        revision: current.revision + 1, updatedAt: new Date().toISOString() });
      const updated = await db.updateTable("chat_project_setups").set({ revision: draft.revision, draft: jsonb(draft), last_request_id: input.clientRequestId, last_request_hash: requestHash, updated_at: draft.updatedAt })
        .where("chat_id", "=", chatId).where("owner_id", "=", owner.ownerId).where("root_fingerprint", "=", fingerprint).where("revision", "=", input.baseRevision).returning("chat_id").executeTakeFirst();
      if (!updated) throw new ProjectSetupError("conflict");
      return { draft, record: (await repository.get(owner, chatId))! };
    });
  }
}
