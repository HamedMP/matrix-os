import { createHash } from "node:crypto";
import type { CanonicalChatModelSelection, ProjectSetupDraft } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatOrchestrator } from "./orchestrator.js";
import type { ChatProviderCatalogService } from "./provider-catalog.js";
import { PROJECT_SETUP_DRAFTING } from "./turn-admission.js";
import { applyProjectSetupGeneration, projectSetupGenerationPrompt, ProjectSetupError } from "./project-setup-state.js";

export interface ProjectSetupGenerationDependencies {
  repository: ChatRepository;
  orchestrator: Pick<CanonicalChatOrchestrator, "admitTurn">;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
}

export async function generateProjectSetup(deps: ProjectSetupGenerationDependencies, principal: RequestPrincipal, owner: ChatOwner,
  draft: ProjectSetupDraft, selection: CanonicalChatModelSelection, requestId: string): Promise<NonNullable<ProjectSetupDraft["generation"]>> {
  const catalog = await deps.catalog.getCatalog(principal, selection);
  const instance = catalog.instances.find(entry => entry.id === selection.instanceId);
  if (!instance || !["codex", "claude_code"].includes(instance.driverKind) || !instance.supports.interactionModes.includes("review")
    || !instance.supports.permissionModes.includes("supervised")) return { status: "unavailable" };
  const record = await deps.repository.get(owner, draft.chatId);
  if (!record || record.projectId !== draft.projectId || record.activeRun) throw new ProjectSetupError("busy");
  const response = await deps.orchestrator.admitTurn(principal, owner, draft.chatId, {
    clientRequestId: `req_setup_${createHash("sha256").update(requestId).digest("hex")}`,
    baseRevision: record.chat.revision,
    parts: [{ type: "text", text: projectSetupGenerationPrompt(draft) }], selection,
    interactionMode: "review", permissionMode: "supervised", executionRoot: { kind: "project", projectId: draft.projectId },
  }, { [PROJECT_SETUP_DRAFTING]: { revision: draft.revision } });
  return { status: "running", runId: response.run.id, sourceRevision: draft.revision };
}

export async function syncProjectSetupGeneration(repository: ChatRepository, owner: ChatOwner, draft: ProjectSetupDraft): Promise<ProjectSetupDraft> {
  const runId = draft.generation?.runId;
  if (!runId || draft.generation?.status !== "running") return draft;
  const run = await repository.kysely.selectFrom("chat_runs").selectAll().where("id", "=", runId).where("chat_id", "=", draft.chatId).executeTakeFirst();
  if (!run) throw new ProjectSetupError("not_found");
  const context = typeof run.context_snapshot === "string" ? JSON.parse(run.context_snapshot) : run.context_snapshot;
  if (!context || typeof context !== "object" || !("projectSetupDraft" in context)
    || (context.projectSetupDraft as { revision?: unknown })?.revision !== draft.generation.sourceRevision) throw new ProjectSetupError("conflict");
  if (["failed", "aborted"].includes(run.status)) return { ...draft, generation: { ...draft.generation, status: "failed" } };
  if (run.status !== "completed") return draft;
  const messages = await repository.kysely.selectFrom("chat_messages").select(["parts", "byte_count"]).where("chat_id", "=", draft.chatId)
    .where("run_id", "=", runId).where("role", "=", "assistant").where("state", "=", "committed").orderBy("seq").limit(32).execute();
  if (messages.reduce((sum, row) => sum + Number(row.byte_count), 0) > 128 * 1024) throw new ProjectSetupError("invalid");
  const text = messages.flatMap(row => {
    const parts: unknown = typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts;
    if (!Array.isArray(parts)) throw new ProjectSetupError("invalid");
    return parts.flatMap(part => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string" ? [part.text] : []);
  }).join("");
  try { return applyProjectSetupGeneration(draft, text); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError || error instanceof ProjectSetupError || (error instanceof Error && error.name === "ZodError"))) throw error;
    console.warn("[project-setup] Generated draft did not match the bounded proposal contract");
    return { ...draft, generation: { ...draft.generation, status: "failed" } };
  }
}
