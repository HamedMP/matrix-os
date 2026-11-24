import { createHash } from "node:crypto";
import { canonicalAssistantOutputMessages, CanonicalChatExecutionRootRefSchema, type CanonicalChatModelSelection, type ProjectSetupDraft } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import { toMessage } from "./records.js";
import type { CanonicalChatOrchestrator } from "./orchestrator.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";
import { PROJECT_SETUP_DRAFTING } from "./turn-admission.js";
import { applyProjectSetupGeneration, applyProjectSetupInterview, projectSetupGenerationPrompt, projectSetupInterviewPrompt, ProjectSetupError } from "./project-setup-state.js";
import { supportsProjectSetupInterviewProvider, type ProjectSetupInterviewContext } from "./project-setup-interview-context.js";

export interface ProjectSetupGenerationDependencies {
  repository: ChatRepository;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
}

type SetupGeneration = NonNullable<ProjectSetupDraft["generation"]>;
function admissionId(draft: ProjectSetupDraft, requestId: string): string {
  const key = draft.interview ? JSON.stringify([draft.chatId, draft.revision, requestId]) : requestId;
  return `req_setup_${createHash("sha256").update(key).digest("hex")}`;
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
    || (context.projectSetupDraft as { revision?: unknown })?.revision !== sourceRevision
    || Boolean(draft.interview) !== ((context.projectSetupDraft as { mode?: unknown })?.mode === "interview")) throw new ProjectSetupError("conflict");
}

async function findSetupAdmission(repository: ChatRepository, owner: ChatOwner, draft: ProjectSetupDraft, requestId: string,
  executionRootFingerprint: string) {
  const canonicalRequestId = admissionId(draft, requestId);
  // A general admission retry still needs its original request hash, including the old Chat revision.
  const run = await ownedSetupRuns(repository, owner, draft).innerJoin("chat_turns as turns", "turns.id", "runs.turn_id")
    .where("turns.chat_id", "=", draft.chatId).where("turns.client_request_id", "=", canonicalRequestId)
    .where("runs.client_request_id", "=", canonicalRequestId).where("runs.attempt", "=", 1).executeTakeFirst();
  if (run) validateSetupRun(run, draft, draft.revision, executionRootFingerprint);
  return run;
}

async function interviewTranscript(repository: ChatRepository, draft: ProjectSetupDraft) {
  const messages = await repository.kysely.selectFrom("chat_messages as messages")
    .innerJoin("chat_turns as turns", "turns.id", "messages.turn_id")
    .leftJoin("chat_runs as runs", "runs.turn_id", "turns.id")
    .selectAll("messages").where("messages.chat_id", "=", draft.chatId).where("turns.chat_id", "=", draft.chatId)
    .where("runs.id", "is", null).where("messages.role", "in", ["user", "assistant"])
    .where("messages.state", "=", "committed").orderBy("messages.seq", "desc").limit(12).execute();
  return messages.reverse().map(row => ({ role: row.role === "user" ? "user" as const : "assistant" as const,
    text: toMessage(row).parts.flatMap(part => part.type === "text" ? [part.text] : []).join("").slice(0, 4096),
  }));
}

export async function generateProjectSetup(deps: ProjectSetupGenerationDependencies, principal: RequestPrincipal, owner: ChatOwner,
  draft: ProjectSetupDraft, selection: CanonicalChatModelSelection, requestId: string, executionRootFingerprint: string,
  interviewContext?: ProjectSetupInterviewContext): Promise<SetupGeneration> {
  const recover = () => findSetupAdmission(deps.repository, owner, draft, requestId, executionRootFingerprint);
  const admitted = await recover();
  if (admitted) return { status: "running", runId: admitted.id, sourceRevision: draft.revision };
  const catalog = await deps.catalog.getCatalog(principal, selection);
  const instance = catalog.instances.find(entry => entry.id === selection.instanceId);
  const interactionMode = instance?.driverKind === "matrix_pi" ? "default" : "review";
  if (!instance || !["codex", "claude_code", "matrix_pi"].includes(instance.driverKind) || !instance.supports.interactionModes.includes(interactionMode)
    || !instance.supports.permissionModes.includes("supervised")) return { status: "unavailable" };
  if (draft.interview && (!interviewContext || !supportsProjectSetupInterviewProvider(instance.driverKind))) return { status: "unavailable" };
  try {
    const record = await deps.repository.get(owner, draft.chatId);
    if (!record || record.projectId !== draft.projectId) throw new ProjectSetupError("not_found");
    if (record.activeRun) throw new ProjectSetupError("busy");
    const prompt = draft.interview && interviewContext
      ? projectSetupInterviewPrompt(draft, interviewContext, await interviewTranscript(deps.repository, draft)) : undefined;
    const response = await deps.orchestrator.admitTurn(principal, owner, draft.chatId, {
      clientRequestId: admissionId(draft, requestId),
      baseRevision: record.chat.revision,
      parts: [{ type: "text", text: prompt ? "Project setup interview." : projectSetupGenerationPrompt(draft) }], selection,
      interactionMode, permissionMode: "supervised", executionRoot: { kind: "project", projectId: draft.projectId },
    }, { [PROJECT_SETUP_DRAFTING]: prompt ? { revision: draft.revision, mode: "interview", prompt } : { revision: draft.revision } });
    return { status: "running", runId: response.run.id, sourceRevision: draft.revision };
  } catch (error: unknown) {
    // The same request may have won admission on another process with newer inventory.
    const replay = await recover();
    if (replay) return { status: "running", runId: replay.id, sourceRevision: draft.revision };
    throw error;
  }
}

export async function syncProjectSetupGeneration(repository: ChatRepository, owner: ChatOwner, draft: ProjectSetupDraft,
  executionRootFingerprint: string, lastRequestId: string | null = null): Promise<ProjectSetupDraft> {
  return (await syncProjectSetupResult(repository, owner, draft, executionRootFingerprint, undefined, lastRequestId)).draft;
}

export async function isProjectSetupInterviewResultReady(repository: ChatRepository, draft: ProjectSetupDraft): Promise<boolean> {
  const runId = draft.generation?.runId;
  if (!draft.interview || !runId || draft.generation?.status !== "running") return false;
  const run = await repository.kysely.selectFrom("chat_runs").select("status").where("chat_id", "=", draft.chatId).where("id", "=", runId).executeTakeFirst();
  return run?.status === "completed";
}

export async function syncProjectSetupResult(repository: ChatRepository, owner: ChatOwner, current: ProjectSetupDraft,
  executionRootFingerprint: string, interviewResult?: { runId: string; context: ProjectSetupInterviewContext | null }, lastRequestId?: string | null):
  Promise<{ draft: ProjectSetupDraft; assistantText?: string }> {
  let draft = current;
  if (current.generation?.status === "pending") {
    const interviewTimedOut = current.interview && Date.now() - Date.parse(current.updatedAt) > 60_000;
    if (current.interview && !interviewTimedOut) return { draft: current };
    // Recover a process that was interrupted between canonical admission and linking the run.
    const prior = lastRequestId ? await findSetupAdmission(repository, owner, current, lastRequestId, executionRootFingerprint) : undefined;
    if (!prior) return { draft: interviewTimedOut ? { ...current, generation: { status: "failed" } } : current };
    draft = { ...current, generation: { status: "running", runId: prior.id, sourceRevision: current.revision } };
    // Interview output needs the next request's unlocked inventory preflight.
    if (current.interview) return { draft };
  }
  const runId = draft.generation?.runId;
  if (!runId || draft.generation?.status !== "running") return { draft };
  const run = await ownedSetupRuns(repository, owner, draft).where("runs.id", "=", runId).executeTakeFirst();
  if (!run) throw new ProjectSetupError("not_found");
  validateSetupRun(run, draft, draft.generation.sourceRevision, executionRootFingerprint);
  if (["failed", "aborted"].includes(run.status)) return { draft: { ...draft, generation: { ...draft.generation, status: "failed" } } };
  if (run.status !== "completed") return { draft };
  // The run may have completed after the request's unlocked inventory preflight.
  if (draft.interview && interviewResult?.runId !== runId) return { draft };
  const messages = await repository.kysely.selectFrom("chat_messages").selectAll().where("chat_id", "=", draft.chatId)
    .where("run_id", "=", runId).where("role", "=", "assistant").where("state", "=", "committed").orderBy("seq").limit(33).execute();
  try {
    if (messages.length > 32 || messages.reduce((sum, row) => sum + Number(row.byte_count), 0) > 128 * 1024) throw new ProjectSetupError("invalid");
    const result = canonicalAssistantOutputMessages(messages.map(toMessage)).at(-1);
    const text = result?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
    if (!draft.interview) return { draft: applyProjectSetupGeneration(draft, text) };
    if (!interviewResult?.context) throw new ProjectSetupError("unavailable");
    return applyProjectSetupInterview(draft, text, interviewResult.context);
  }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError || error instanceof ProjectSetupError || (error instanceof Error && error.name === "ZodError"))) throw error;
    console.warn("[project-setup] Generated draft did not match the bounded proposal contract");
    return { draft: { ...draft, generation: { ...draft.generation, status: "failed" } } };
  }
}
