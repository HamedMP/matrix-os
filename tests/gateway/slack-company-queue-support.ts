import { createHash } from "node:crypto";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { collaborationActors as actors, collaborationExecutionEligibility, type CollaborationTestDatabase } from "./collaboration-test-support.js";

/** Exercise the durable queue's committed-message schema, beyond enqueue's wider parts schema. */
export async function claimSlackCompanyPrompt(fixture: CollaborationTestDatabase, text: string) {
  const chatId = "chat_slack_prompt_claim", scopeId = "60000000-0000-4000-8000-000000000001";
  const now = "2026-09-30T11:00:00.000Z";
  const repository = new ChatRepository(fixture.db);
  await fixture.db.insertInto("chats").values({ id: chatId, owner_type: "personal", owner_id: actors.owner,
    create_request_id: "req_slack_prompt_claim", project_id: null, title: "Synthetic Slack queue", lifecycle: "active", attention: "none",
    revision: 1, message_count: 0, collaboration: JSON.stringify({ scopeId, mode: "shared_ai", executionFenced: true }),
    user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null,
    current_selection: JSON.stringify({ instanceId: "claude_code_default", model: "opus" }), bound_driver_kind: "claude_code",
    bound_instance_id: "claude_code_default", bound_at_turn_id: "cturn_original_claude", created_at: now, updated_at: now }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({ id: scopeId, owner_type: "personal", owner_id: actors.owner,
    kind: "chat", organization_id: "org_team", resource_id: chatId, parent_scope_id: null, membership_mode: "direct", lifecycle: "shared",
    revision: 1, auth_epoch: 1, authority_runtime_id: "runtime_slack_claim", authority_generation: 1, execution_generation: 1,
    execution_eligibility: JSON.stringify(collaborationExecutionEligibility()), deleted_at: null, created_at: now, updated_at: now }).execute();
  await fixture.db.insertInto("collaboration_members").values({ scope_id: scopeId, actor_id: actors.owner, role: "owner", status: "accepted",
    invitation_id: null, invited_by: actors.owner, accepted_at: now, expires_at: null, revision: 1, joined_at: now, updated_at: now }).execute();
  const queued = await repository.enqueueSharedQueuedTurn({ type: "personal", ownerId: actors.owner }, {
    chatId, scopeId, queuedTurnId: "qturn_slack_prompt_claim", clientRequestId: "60000000-0000-4000-8000-000000000002",
    requestingActorId: actors.owner, acceptedAuthEpoch: 1, payloadHash: createHash("sha256").update(text).digest("hex"), expectedRevision: 1,
    parts: [{ type: "text", text }], interactionMode: "default", permissionMode: "supervised", acceptedAt: now,
    capabilitySnapshot: { revision: "shared-catalog-1", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
      userInput: false, resume: true, cancellation: true, steering: "none", worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised"] } });
  const claimed = await repository.claimNextQueuedTurn({ type: "personal", ownerId: actors.owner }, {
    chatId, turnId: "cturn_slack_prompt_claim", runId: "run_slack_prompt_claim", messageId: "msg_slack_prompt_claim", claimedAt: now });
  return { queued, claimed };
}
