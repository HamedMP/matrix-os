import { sql, type Kysely } from "kysely";
import { MATRIX_BOT_SELECTION } from "../bots/selection.js";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { CollaborationAuthority, AuthorizedCollaborationContext } from "../collaboration/authority.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import { createProjectInheritanceResolver } from "../collaboration/project-inheritance.js";
import { parseCollaborationAiEligibility } from "../collaboration/shared-ai-eligibility.js";
import { slackIdentity, slackRequestId, threadKey } from "./repository.js";
import { SlackCompanyError, SlackHomeEnvelopeSchema, type SlackHomeEnvelope, type SlackThreadBinding } from "./schemas.js";

export interface SlackThreadResolverOptions {
  db: Kysely<OwnerCollaborationDatabase>;
  chats: Pick<ChatRepository, "create">;
  authority: Pick<CollaborationAuthority, "authorize">;
  executionRoots: Pick<ChatExecutionRootResolver, "resolve">;
  resolveCompanyBot(input: { ownerId: string; organizationId: string; projectScopeId: string; projectId: string; chatId: string }): Promise<void>;
  getEligibility(input: { ownerId: string; projectScopeId: string; resourceScopeId: string }): Promise<{ generation: number; eligibility: unknown }>;
  initializeThread?(input: { ownerId: string; organizationId: string; scopeId: string; chatId: string; projectScopeId: string; clientRequestId: string }): Promise<void>;
  now?: () => Date;
}

/** Stable Slack thread -> canonical owner Chat, deriving audience from the existing Project resolver. */
export function createSlackThreadResolver(options: SlackThreadResolverOptions) {
  const now = options.now ?? (() => new Date());
  const inheritance = createProjectInheritanceResolver({ db: options.db, now });
  return async (input: { envelope: SlackHomeEnvelope; project: AuthorizedCollaborationContext }): Promise<SlackThreadBinding> => {
    const envelope = SlackHomeEnvelopeSchema.parse(input.envelope);
    if (!envelope.channelScopeId || envelope.event.kind !== "mention") throw new SlackCompanyError("forbidden");
    const project = await options.authority.authorize({ scopeId: envelope.channelScopeId, actorId: envelope.actorId, action: "read" });
    if (project.resourceKind !== "project" || project.membershipScopeId !== project.scopeId || project.role === "viewer"
      || project.scopeId !== input.project.scopeId || project.resourceId !== input.project.resourceId || project.authEpoch !== input.project.authEpoch
      || project.organizationId !== envelope.organizationId || project.ownerId !== envelope.ownerId
      || project.authorityRuntimeId !== input.project.authorityRuntimeId || project.authorityGeneration !== input.project.authorityGeneration) throw new SlackCompanyError("forbidden");
    const owner = { type: "personal" as const, ownerId: project.ownerId };
    const root = await options.executionRoots.resolve(owner, { kind: "project", projectId: project.resourceId });
    if (root.ref.kind !== "project" || root.ref.projectId !== project.resourceId) throw new SlackCompanyError("forbidden");
    const identity = [project.ownerId, project.scopeId, threadKey(envelope)];
    const chatId = `chat_slack_${slackIdentity(identity).slice(0,40)}`;
    // Chat creation is separately atomic and idempotent. A crash may leave an owner-private orphan;
    // replay uses this same ID and resumes inheritance, without copying memberships or grants.
    const existingChat = await options.db.selectFrom("chats").select(["id","owner_type","owner_id","project_id","revision"])
      .where("id","=",chatId).executeTakeFirst();
    if (existingChat && (existingChat.owner_type !== "personal" || existingChat.owner_id !== project.ownerId || existingChat.project_id !== project.resourceId)) throw new SlackCompanyError("forbidden");
    const created = existingChat ? null : await options.chats.create(owner, { id: chatId, clientRequestId: `req_${slackIdentity(identity).slice(0,32)}`,
      title: "Company Slack thread", projectId: project.resourceId, currentSelection: MATRIX_BOT_SELECTION });
    if (created && created.chat.id !== chatId) throw new SlackCompanyError("forbidden");
    await options.resolveCompanyBot({ ownerId: project.ownerId, organizationId: project.organizationId, projectScopeId: project.scopeId, projectId: project.resourceId, chatId });
    const old = await inheritance.resolve({ projectScopeId: project.scopeId, ownerId: project.ownerId, kind: "chat", resourceId: chatId });
    const binding = old ?? await inheritance.bindOwnedResource({ projectScopeId: project.scopeId, ownerId: project.ownerId, kind: "chat", resourceId: chatId,
      authorityRuntimeId: project.authorityRuntimeId, authorityGeneration: project.authorityGeneration, revision: existingChat ? Number(existingChat.revision) : created!.chat.revision, readiness: "ready" });
    if (!binding.resourceScopeId || binding.projectScopeId !== project.scopeId || binding.membershipScopeId !== project.scopeId
      || binding.authorityRuntimeId !== project.authorityRuntimeId || binding.authorityGeneration !== project.authorityGeneration || binding.readiness !== "ready") throw new SlackCompanyError("forbidden");
    const capability = await options.getEligibility({ ownerId: project.ownerId, projectScopeId: project.scopeId, resourceScopeId: binding.resourceScopeId });
    const eligibility = parseCollaborationAiEligibility(capability.eligibility);
    if (!eligibility.matrixBot || !Number.isSafeInteger(capability.generation) || capability.generation < 1) throw new SlackCompanyError("unavailable");
    await options.db.transaction().execute(async (trx) => {
      // Match canonical admission and source-capture ordering: child before inherited parent.
      const child = await trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", binding.resourceScopeId!).forUpdate().executeTakeFirst();
      const parent = await trx.selectFrom("collaboration_scopes").selectAll().where("id", "=", project.scopeId).forUpdate().executeTakeFirst();
      const chat = await trx.selectFrom("chats").selectAll().where("id", "=", chatId).where("owner_type", "=", "personal").where("owner_id", "=", project.ownerId).forUpdate().executeTakeFirst();
      if (!parent || !child || !chat || parent.deleted_at || child.deleted_at || parent.lifecycle !== "shared" || child.lifecycle !== "shared"
        || parent.owner_id !== project.ownerId || parent.organization_id !== project.organizationId || parent.resource_id !== project.resourceId
        || Number(parent.auth_epoch) !== project.authEpoch || parent.authority_runtime_id !== project.authorityRuntimeId || Number(parent.authority_generation) !== project.authorityGeneration
        || child.parent_scope_id !== project.scopeId || child.membership_mode !== "inherited" || child.resource_id !== chatId
        || child.owner_id !== project.ownerId || child.organization_id !== project.organizationId || child.authority_runtime_id !== project.authorityRuntimeId
        || Number(child.authority_generation) !== project.authorityGeneration || chat.project_id !== project.resourceId || chat.lifecycle !== "active"
        || (child.execution_generation !== null && Number(child.execution_generation) > capability.generation)) throw new SlackCompanyError("forbidden");
      const selection = typeof chat.current_selection === "string" ? JSON.parse(chat.current_selection) : chat.current_selection;
      if (!selection || typeof selection !== "object" || (selection as {instanceId?: unknown}).instanceId !== MATRIX_BOT_SELECTION.instanceId) throw new SlackCompanyError("forbidden");
      await trx.updateTable("collaboration_scopes").set({ execution_generation: capability.generation, execution_eligibility: sql`${JSON.stringify(eligibility)}::jsonb`, updated_at: now() })
        .where("id", "=", child.id).where("auth_epoch", "=", Number(child.auth_epoch)).execute();
      await trx.updateTable("chats").set({ collaboration: sql`${JSON.stringify({ scopeId: child.id, membershipScopeId: project.scopeId, executionFenced: true })}::jsonb`, updated_at: now() })
        .where("id", "=", chatId).where("revision", "=", Number(chat.revision)).execute();
    });
    // Never fabricate provider binding. Optional owner initialization uses the canonical queue.
    await options.initializeThread?.({ ownerId: project.ownerId, organizationId: project.organizationId, scopeId: binding.resourceScopeId,
      chatId, projectScopeId: project.scopeId, clientRequestId: slackRequestId([identity,"initialize"]) });
    const current = await options.authority.authorize({ scopeId: binding.resourceScopeId, actorId: envelope.actorId, action: "request_ai" });
    if (current.membershipScopeId !== project.scopeId || current.resourceId !== chatId || current.organizationId !== project.organizationId
      || current.ownerId !== project.ownerId) throw new SlackCompanyError("forbidden");
    return { scopeId: binding.resourceScopeId, chatId, projectScopeId: project.scopeId, projectId: project.resourceId };
  };
}
