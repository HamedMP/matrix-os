import type { CanonicalChatRun, ProjectAgentContext } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { parseJson, type ChatOwner } from "./records.js";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";
import { redactSharedAssistantText } from "./safe-activity-projection.js";

export interface ProjectSetupInterviewMcpService {
  name: string;
  connection: "connected" | "authorization_required" | "unconfirmed";
}

export type LoadProjectSetupMcpServices = (owner: ChatOwner) => Promise<ProjectSetupInterviewMcpService[]>;

export interface ProjectSetupInterviewProject {
  name: string;
  description?: string;
  source?: { type: "github" | "scratch" | "folder"; repository?: string };
}

export interface ProjectSetupInterviewContext {
  project: ProjectSetupInterviewProject;
  instructionFiles: string[];
  skills: { name: string; path: string }[];
  mcpServices: ProjectSetupInterviewMcpService[];
}

const RepositoryComponent = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const ProjectSource = z.enum(["github", "scratch", "folder"]);

export function projectSetupInterviewProject(project: {
  slug: string; name?: string; description?: string; kind?: string; github?: { owner?: string; repo?: string };
}): ProjectSetupInterviewProject {
  const type = ProjectSource.safeParse(project.kind);
  const owner = RepositoryComponent.safeParse(project.github?.owner);
  const repo = RepositoryComponent.safeParse(project.github?.repo);
  const name = project.name?.trim().slice(0, 200);
  const description = project.description?.trim().slice(0, 1000);
  return {
    name: name ? redactSharedAssistantText(name) : project.slug,
    ...(description ? { description: redactSharedAssistantText(description) } : {}),
    ...(type.success ? { source: { type: type.data,
      ...(type.data === "github" && owner.success && repo.success ? { repository: `${owner.data}/${repo.data}` } : {}) } } : {}),
  };
}

export function projectSetupInterviewInventory(project: ProjectSetupInterviewProject, inventory: ProjectAgentContext,
  mcpServices: ProjectSetupInterviewMcpService[]): ProjectSetupInterviewContext {
  return {
    project,
    instructionFiles: inventory.instructions,
    skills: inventory.skills.slice(0, 32).map(({ name, source }) => ({ name, path: `${source}/${name}/SKILL.md` })),
    mcpServices: mcpServices.slice(0, 40),
  };
}

export function isProjectSetupInterview(context: unknown) {
  return parseJson<CanonicalChatRun["context"]>(context)?.projectSetupDraft?.mode === "interview";
}

export function supportsProjectSetupInterviewProvider(driver: string): boolean {
  return driver === "claude_code" || driver === "matrix_pi";
}

export function validateProjectSetupInterviewInput(input: CanonicalProviderRunInput, interactionMode: "review" | "default"): void {
  if (input.owner.type !== "personal" || !input.executionRoot || input.worktreeId || input.sharedScopeId
    || input.permissionMode !== "supervised" || input.interactionMode !== interactionMode
    || input.resumeState || input.continuationId || input.nativeScheduled || input.parts.some(part => part.type !== "text")
    || input.context?.agent || input.context?.history || input.context?.drives?.length || input.context?.chats.length
    || input.context?.routineCreation) throw new Error("Project setup interview unavailable");
}
