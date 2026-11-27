import { createHash } from "node:crypto";
import { canonicalAssistantOutputMessages, CanonicalChatExecutionRootRefSchema, type CanonicalChatModelSelection, type ProjectSetupDraft } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { toMessage } from "./records.js";
import type { CanonicalChatOrchestrator } from "./orchestrator.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";
import { PROJECT_SETUP_DRAFTING } from "./turn-admission.js";
import { applyProjectSetupGeneration, projectSetupGenerationPrompt, ProjectSetupError } from "./project-setup-state.js";

export interface ProjectSetupGenerationDependencies {
  repository: ChatRepository;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
}

type SetupGeneration = NonNullable<ProjectSetupDraft["generation"]>;

function admissionId(requestId: string): string {
  return `req_setup_${createHash("sha256").update(requestId).digest("hex")}`;
}

function ownedSetupRuns(repository: ChatRepository, owner: ChatOwner, draft: ProjectSetupDraft) {
  return repository.kysely.selectFrom("chat_runs as runs")
    .innerJoin("chats", "chats.id", "runs.chat_id")
    .select(["runs.id", "runs.status", "runs.context_snapshot", "runs.execution_root", "runs.execution_root_fingerprint"])
    .where("runs.chat_id", "=", draft.chatId).where("chats.project_id", "=", draft.projectId)
    .where("chats.owner_type", "=", owner.type).where("chats.owner_id", "=", owner.ownerId)
    .where("chats.lifecycle", "=", "active").where("chats.collaboration", "is", null);
}

function validateSetupRun(run: { context_snapshot: unknown; execution_root: unknown; execution_root_fingerprint: string | null },
  draft: ProjectSetupDraft, sourceRevision: number | undefined, executionRootFingerprint: string) {
  const context = typeof run.context_snapshot === "string" ? JSON.parse(run.context_snapshot) : run.context_snapshot;
  const root = CanonicalChatExecutionRootRefSchema.safeParse(typeof run.execution_root === "string" ? JSON.parse(run.execution_root) : run.execution_root);
  if (!root.success || root.data.kind !== "project" || root.data.projectId !== draft.projectId
    || run.execution_root_fingerprint !== executionRootFingerprint || sourceRevision === undefined
    || !context || typeof context !== "object" || !("projectSetupDraft" in context)
    || (context.projectSetupDraft as { revision?: unknown })?.revision !== sourceRevision) throw new ProjectSetupError("conflict");
}

async function findSetupAdmission(repository: ChatRepository, owner: ChatOwner, draft: ProjectSetupDraft, requestId: string,
  executionRootFingerprint: string) {
  const canonicalRequestId = admissionId(requestId);
  // A general admission retry still needs its original request hash, including the old Chat revision.
  const run = await ownedSetupRuns(repository, owner, draft).innerJoin("chat_turns as turns", "turns.id", "runs.turn_id")
    .where("turns.chat_id", "=", draft.chatId).where("turns.client_request_id", "=", canonicalRequestId)
    .where("runs.client_request_id", "=", canonicalRequestId).executeTakeFirst();
  if (run) validateSetupRun(run, draft, draft.revision, executionRootFingerprint);
  return run;
}

export async function generateProjectSetup(deps: ProjectSetupGenerationDependencies, principal: RequestPrincipal, owner: ChatOwner,
  draft: ProjectSetupDraft, selection: CanonicalChatModelSelection, requestId: string, executionRootFingerprint: string): Promise<SetupGeneration> {
  const recover = () => findSetupAdmission(deps.repository, owner, draft, requestId, executionRootFingerprint);
  const admitted = await recover();
  if (admitted) return { status: "running", runId: admitted.id, sourceRevision: draft.revision };
  const catalog = await deps.catalog.getCatalog(principal, selection);
  const instance = catalog.instances.find(entry => entry.id === selection.instanceId);
  const interactionMode = instance?.driverKind === "matrix_pi" ? "default" : "review";
  if (!instance || !["codex", "claude_code", "matrix_pi"].includes(instance.driverKind) || !instance.supports.interactionModes.includes(interactionMode)
    || !instance.supports.permissionModes.includes("supervised")) return { status: "unavailable" };
  try {
    const record = await deps.repository.get(owner, draft.chatId);
    if (!record || record.projectId !== draft.projectId || record.activeRun) throw new ProjectSetupError("busy");
    const response = await deps.orchestrator.admitTurn(principal, owner, draft.chatId, {
      clientRequestId: admissionId(requestId),
      baseRevision: record.chat.revision,
      parts: [{ type: "text", text: projectSetupGenerationPrompt(draft) }], selection,
      interactionMode, permissionMode: "supervised", executionRoot: { kind: "project", projectId: draft.projectId },
    }, { [PROJECT_SETUP_DRAFTING]: { revision: draft.revision } });
    return { status: "running", runId: response.run.id, sourceRevision: draft.revision };
  } catch (error: unknown) {
    // A concurrent retry can finish admission before this request reaches the Chat lock.
    const replay = await recover();
    if (replay) return { status: "running", runId: replay.id, sourceRevision: draft.revision };
    throw error;
  }
}

export async function syncProjectSetupGeneration(repository: ChatRepository, owner: ChatOwner, current: ProjectSetupDraft,
  executionRootFingerprint: string, lastRequestId: string | null = null): Promise<ProjectSetupDraft> {
  let draft = current;
  if (current.generation?.status === "pending" && lastRequestId) {
    const admitted = await findSetupAdmission(repository, owner, current, lastRequestId, executionRootFingerprint);
    if (admitted) draft = { ...current, generation: { status: "running", runId: admitted.id, sourceRevision: current.revision } };
  }
  const runId = draft.generation?.runId;
  if (!runId || draft.generation?.status !== "running") return draft;
  const run = await ownedSetupRuns(repository, owner, draft).where("runs.id", "=", runId).executeTakeFirst();
  if (!run) throw new ProjectSetupError("not_found");
  validateSetupRun(run, draft, draft.generation.sourceRevision, executionRootFingerprint);
  if (["failed", "aborted"].includes(run.status)) return { ...draft, generation: { ...draft.generation, status: "failed" } };
  if (run.status !== "completed") return draft;
  const messages = await repository.kysely.selectFrom("chat_messages").selectAll().where("chat_id", "=", draft.chatId)
    .where("run_id", "=", runId).where("role", "=", "assistant").where("state", "=", "committed").orderBy("seq").limit(33).execute();
  if (messages.length > 32 || messages.reduce((sum, row) => sum + Number(row.byte_count), 0) > 128 * 1024) throw new ProjectSetupError("invalid");
  // Commentary remains in Chat; only the final logical reply is the structured result.
  const result = canonicalAssistantOutputMessages(messages.map(toMessage)).at(-1);
  const text = result?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
  try { return applyProjectSetupGeneration(draft, text); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError || error instanceof ProjectSetupError || (error instanceof Error && error.name === "ZodError"))) throw error;
    console.warn("[project-setup] Generated draft did not match the bounded proposal contract");
    return { ...draft, generation: { ...draft.generation, status: "failed" } };
  }
}
