import type { ProjectSetupDraft, ProjectSetupResponse, ProjectSetupStartRequest, ProjectSetupUpdateRequest } from "@matrix-os/contracts";
import { withOwnerFileMutation } from "../owner-file-mutations.js";
import { withProjectLock } from "../state-ops.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import { ProjectSetupRepository } from "./project-setup-repository.js";
import { openProjectSetupWorkspace, type ProjectSetupWorkspace } from "./project-setup-workspace.js";
import { ProjectSetupError, transitionProjectSetup, PROJECT_SETUP_QUESTIONS } from "./project-setup-state.js";
import { inspectProjectSetupFiles, saveProjectSetupFiles } from "./project-setup-files.js";
import { generateProjectSetup, syncProjectSetupGeneration, type ProjectSetupGenerationDependencies } from "./project-setup-generation.js";

export interface ProjectSetupServiceOptions {
  repository: ChatRepository;
  executionRoots: ChatExecutionRootResolver;
  homePath: string;
  generation?: ProjectSetupGenerationDependencies;
  openWorkspace?: (owner: ChatOwner, projectId: string) => Promise<ProjectSetupWorkspace>;
}

export class ProjectSetupService {
  private readonly drafts: ProjectSetupRepository;
  constructor(private readonly options: ProjectSetupServiceOptions) { this.drafts = new ProjectSetupRepository(options.repository); }

  private async workspace<T>(owner: ChatOwner, projectId: string, operation: (workspace: ProjectSetupWorkspace) => Promise<T>): Promise<T> {
    const workspace = await (this.options.openWorkspace?.(owner, projectId)
      ?? openProjectSetupWorkspace(this.options.executionRoots, this.options.homePath, owner, projectId));
    try { const result = await operation(workspace); await workspace.revalidate(); return result; }
    finally { await workspace.close(); }
  }

  private async projectForChat(owner: ChatOwner, chatId: string): Promise<string> {
    const record = await this.options.repository.get(owner, chatId);
    if (owner.type !== "personal" || !record?.projectId || record.chat.lifecycle !== "active" || record.chat.collaboration) throw new ProjectSetupError("not_found");
    return record.projectId;
  }

  getProject(owner: ChatOwner, projectId: string): Promise<ProjectSetupResponse> {
    return this.workspace(owner, projectId, async workspace => {
      const draft = await this.drafts.getByProject(owner, projectId, workspace.fingerprint);
      if (!draft) return { draft: null };
      const record = await this.options.repository.get(owner, draft.chatId);
      if (!record || record.projectId !== projectId || record.chat.lifecycle !== "active" || record.chat.collaboration) return { draft: null };
      return { draft, record };
    });
  }

  start(owner: ChatOwner, projectId: string, input: ProjectSetupStartRequest): Promise<ProjectSetupResponse> {
    return this.workspace(owner, projectId, workspace => this.drafts.start(owner, projectId, workspace.fingerprint, input));
  }

  async getChat(owner: ChatOwner, chatId: string): Promise<ProjectSetupResponse> {
    const projectId = await this.projectForChat(owner, chatId);
    return this.workspace(owner, projectId, async workspace => ({ draft: await this.drafts.getByChat(owner, chatId, workspace.fingerprint) }));
  }

  async update(principal: RequestPrincipal, owner: ChatOwner, chatId: string, input: ProjectSetupUpdateRequest): Promise<ProjectSetupResponse> {
    const projectId = await this.projectForChat(owner, chatId);
    return this.workspace(owner, projectId, async workspace => {
      const mutate = () => this.drafts.mutate(owner, chatId, workspace.fingerprint, input, async (current, repository, lastRequestId) => {
        await workspace.revalidate();
        if (input.action.type === "save") {
          const draft = await saveProjectSetupFiles(workspace, current);
          const saved = draft.proposals.some(file => file.path.endsWith("/SKILL.md") && ["symlink_skipped", "destination_unavailable"].includes(file.status))
            ? "Project setup is complete. The skill was skipped because its destination is unavailable."
            : PROJECT_SETUP_QUESTIONS.saved;
          return { draft, userText: "Save this project setup.", assistantText: draft.step === "saved" ? saved
            : "Some project files need attention. Existing files were preserved. Review the file results and retry the remaining files." };
        }
        if (input.action.type === "sync_generation") {
          const draft = await syncProjectSetupGeneration(repository, owner, current, workspace.executionRootFingerprint, lastRequestId);
          return { draft: draft.generation?.status === "completed" ? await inspectProjectSetupFiles(workspace, draft) : draft };
        }
        const result = transitionProjectSetup(current, input.action);
        if (result.draft.step === "review" && input.action.type !== "generate") result.draft = await inspectProjectSetupFiles(workspace, result.draft);
        return result;
      });
      const result = input.action.type === "save"
        ? await withOwnerFileMutation(this.options.homePath, () => withProjectLock(workspace.projectSlug, mutate))
        : await mutate();
      if (input.action.type !== "generate" || !result.draft || result.draft.generation?.status !== "pending") return result;
      let generation: NonNullable<ProjectSetupDraft["generation"]>;
      try {
        generation = this.options.generation
          ? await generateProjectSetup(this.options.generation, principal, owner, result.draft, input.action.selection, input.clientRequestId, workspace.executionRootFingerprint)
          : { status: "unavailable" };
      } catch (error: unknown) {
        console.warn("[project-setup] Draft generation failed:", error instanceof Error ? error.name : "UnknownError");
        generation = { status: "failed" };
      }
      await workspace.revalidate();
      const draft = await this.drafts.linkGeneration(owner, chatId, workspace.fingerprint, input.clientRequestId, generation);
      return { draft, record: (await this.options.repository.get(owner, chatId))! };
    });
  }
}
