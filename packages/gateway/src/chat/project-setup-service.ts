import type { CanonicalChatModelSelection, ProjectSetupDraft, ProjectSetupResponse, ProjectSetupStartRequest, ProjectSetupUpdateRequest } from "@matrix-os/contracts";
import { withOwnerFileMutation } from "../owner-file-mutations.js";
import { withProjectLock } from "../state-ops.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import { ProjectSetupRepository } from "./project-setup-repository.js";
import { openProjectSetupWorkspace, type ProjectSetupWorkspace } from "./project-setup-workspace.js";
import { beginProjectSetupInterview, ProjectSetupError, transitionProjectSetup, transitionProjectSetupInterview, PROJECT_SETUP_QUESTIONS } from "./project-setup-state.js";
import { inspectProjectSetupFiles, saveProjectSetupFiles } from "./project-setup-files.js";
import { generateProjectSetup, isProjectSetupInterviewResultReady, syncProjectSetupResult, type ProjectSetupGenerationDependencies } from "./project-setup-generation.js";

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

  start(owner: ChatOwner, projectId: string, input: ProjectSetupStartRequest, principal?: RequestPrincipal): Promise<ProjectSetupResponse> {
    return this.workspace(owner, projectId, async workspace => {
      const { admissionPending, ...result } = await this.drafts.start(owner, projectId, workspace.fingerprint, input);
      if (!("mode" in input) || !result.draft || result.draft.step === "saved") return result;
      if (admissionPending) return this.admit(workspace, principal, owner, result.draft, input.currentSelection, input.clientRequestId);
      if (result.draft.interview) return result;
      const resumed = await this.drafts.mutate(owner, result.draft.chatId, workspace.fingerprint, {
        baseRevision: result.draft.revision, clientRequestId: input.clientRequestId, action: { type: "resume_interview" }, originalRequest: input,
      }, current => ({ draft: beginProjectSetupInterview(current) }));
      return resumed.draft
        ? this.admit(workspace, principal, owner, resumed.draft, input.currentSelection, input.clientRequestId)
        : resumed;
    });
  }

  async getChat(owner: ChatOwner, chatId: string): Promise<ProjectSetupResponse> {
    const projectId = await this.projectForChat(owner, chatId);
    return this.workspace(owner, projectId, async workspace => ({ draft: await this.drafts.getByChat(owner, chatId, workspace.fingerprint) }));
  }

  async update(principal: RequestPrincipal, owner: ChatOwner, chatId: string, input: ProjectSetupUpdateRequest): Promise<ProjectSetupResponse> {
    const projectId = await this.projectForChat(owner, chatId);
    return this.workspace(owner, projectId, async workspace => {
      const interviewResult = input.action.type === "sync_generation"
        ? await this.prepareInterviewResult(workspace, owner, chatId, input.baseRevision)
        : undefined;
      const mutate = () => this.drafts.mutate(owner, chatId, workspace.fingerprint, input, async (current, repository, lastRequestId) => {
        await workspace.revalidate();
        if (input.action.type === "save") {
          const draft = await saveProjectSetupFiles(workspace, current);
          const skippedSkill = draft.proposals.some(file => file.path.endsWith("/SKILL.md") && ["symlink_skipped", "destination_unavailable"].includes(file.status));
          const saved = skippedSkill ? "Project setup is complete. The skill was skipped because its destination is unavailable."
            : current.interview ? (draft.proposals.length ? "Your project setup files are saved." : "Your project setup is complete.")
            : PROJECT_SETUP_QUESTIONS.saved;
          return { draft, userText: "Save this project setup.", assistantText: draft.step === "saved" ? saved
            : "Some project files need attention. Existing files were preserved. Review the file results and retry the remaining files." };
        }
        if (input.action.type === "sync_generation") {
          const result = await syncProjectSetupResult(repository, owner, current, workspace.executionRootFingerprint, interviewResult, lastRequestId);
          if (current === result.draft || result.draft.generation?.status !== "completed" || result.draft.step !== "review") return result;
          return { ...result, draft: await inspectProjectSetupFiles(workspace, result.draft) };
        }
        if (!current.interview && (input.action.type === "interview_answer" || input.action.type === "interview_retry")) throw new ProjectSetupError("conflict");
        const result = current.interview
          ? transitionProjectSetupInterview(current, input.action)
          : transitionProjectSetup(current, input.action);
        if (current.interview && input.action.type !== "review_file") return result;
        if (result.draft.step === "review" && input.action.type !== "generate") result.draft = await inspectProjectSetupFiles(workspace, result.draft);
        return result;
      });
      const result = input.action.type === "save"
        ? await withOwnerFileMutation(this.options.homePath, () => withProjectLock(workspace.projectSlug, mutate))
        : await mutate();
      const action = input.action;
      const admits = action.type === "generate" || action.type === "interview_answer" || action.type === "interview_retry"
        || (result.draft?.interview && (action.type === "stage_skill" || (action.type === "choose_mcp" && action.choice === "skip")));
      if (!admits || !result.draft || result.draft.generation?.status !== "pending") return result;
      return this.admit(workspace, principal, owner, result.draft, action.selection, input.clientRequestId);
    });
  }

  private async prepareInterviewResult(workspace: ProjectSetupWorkspace, owner: ChatOwner, chatId: string, baseRevision: number) {
    const draft = await this.drafts.getByChat(owner, chatId, workspace.fingerprint);
    const runId = draft.generation?.runId;
    if (draft.revision !== baseRevision || !runId || !await isProjectSetupInterviewResultReady(this.options.repository, draft)) return undefined;
    try {
      return { runId, context: await workspace.interviewContext?.() ?? null };
    } catch (error: unknown) {
      if (error instanceof ProjectSetupError && error.kind === "not_found") throw error;
      console.warn("[project-setup] Interview inventory unavailable:", error instanceof Error ? error.name : "UnknownError");
      return { runId, context: null };
    }
  }

  private async admit(workspace: ProjectSetupWorkspace, principal: RequestPrincipal | undefined, owner: ChatOwner,
    current: ProjectSetupDraft, selection: CanonicalChatModelSelection | undefined, requestId: string): Promise<ProjectSetupResponse> {
    await workspace.revalidate();
    let generation: NonNullable<ProjectSetupDraft["generation"]> = { status: "unavailable" };
    const deps = this.options.generation;
    if (deps && principal?.userId === owner.ownerId && selection) {
      try {
        const context = current.interview ? await workspace.interviewContext?.() : undefined;
        await workspace.revalidate();
        if (current.interview) {
          const latest = await this.drafts.getByChat(owner, current.chatId, workspace.fingerprint);
          if (latest.revision !== current.revision) throw new ProjectSetupError("conflict");
          if (latest.generation?.status !== "pending") {
            return { draft: latest, record: (await this.options.repository.get(owner, current.chatId))! };
          }
        }
        generation = await generateProjectSetup(deps, principal, owner, current, selection, requestId, workspace.executionRootFingerprint, context);
      } catch (error: unknown) {
        if (error instanceof ProjectSetupError && ["not_found", "conflict"].includes(error.kind)) throw error;
        console.warn("[project-setup] Draft generation failed:", error instanceof Error ? error.name : "UnknownError");
        generation = { status: "failed" };
      }
    }
    await workspace.revalidate();
    const draft = await this.drafts.linkGeneration(owner, current.chatId, workspace.fingerprint, requestId, generation);
    return { draft, record: (await this.options.repository.get(owner, current.chatId))! };
  }
}
