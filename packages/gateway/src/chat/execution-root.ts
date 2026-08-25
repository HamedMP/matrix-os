import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import {
  CanonicalChatExecutionRootRefSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import type { OwnerScope } from "../state-ops.js";

export interface ChatExecutionRootProject {
  id: string;
  slug: string;
  localPath: string;
}

export interface ChatExecutionRootWorktree {
  id: string;
  projectSlug: string;
  path: string;
  createdAt: string;
}

export interface ChatExecutionRootProjectSource<Project extends ChatExecutionRootProject> {
  getProjectById(
    ownerScope: OwnerScope,
    projectId: string,
  ): Promise<
    | { ok: true; project: Project }
    | { ok: false; status: number; error: unknown }
  >;
  resolveProjectWorkingDirectory(project: Project): Promise<string | null>;
}

export interface ChatExecutionRootWorktreeSource<Worktree extends ChatExecutionRootWorktree> {
  getWorktree(
    projectSlug: string,
    worktreeId: string,
    ownerScope: OwnerScope,
  ): Promise<
    | { ok: true; worktree: Worktree }
    | { ok: false; status: number; error: unknown }
  >;
}

export interface ChatExecutionRootProvenance {
  ref: CanonicalChatExecutionRootRef;
  fingerprint: string;
}

export interface ResolvedChatExecutionRoot extends ChatExecutionRootProvenance {
  /** Gateway-only derived value. Never persist or project this path to a client. */
  primaryWorkspaceRoot: string;
}

export interface ChatExecutionRootResolver {
  resolve(
    ownerScope: CanonicalOwnerScope,
    ref: CanonicalChatExecutionRootRef,
  ): Promise<ResolvedChatExecutionRoot>;
  revalidate(
    ownerScope: CanonicalOwnerScope,
    provenance: ChatExecutionRootProvenance,
  ): Promise<ResolvedChatExecutionRoot>;
}

export class ChatExecutionRootError extends Error {
  constructor(readonly code: "invalid_root" | "root_changed" | "validation_unavailable") {
    super(code);
    this.name = "ChatExecutionRootError";
  }
}

function projectOwnerScope(ownerInput: CanonicalOwnerScope): OwnerScope {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  return {
    type: owner.type === "organization" ? "org" : "user",
    id: owner.ownerId,
  };
}

function dependencyError(status: number): ChatExecutionRootError {
  return new ChatExecutionRootError(status >= 500 ? "validation_unavailable" : "invalid_root");
}

async function canonicalDirectory(candidatePath: string): Promise<string> {
  try {
    const stats = await lstat(candidatePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ChatExecutionRootError("invalid_root");
    }
    return await realpath(candidatePath);
  } catch (error: unknown) {
    if (error instanceof ChatExecutionRootError) throw error;
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") {
        throw new ChatExecutionRootError("invalid_root");
      }
    }
    throw new ChatExecutionRootError("validation_unavailable");
  }
}

function fingerprint(value: {
  owner: CanonicalOwnerScope;
  ref: CanonicalChatExecutionRootRef;
  project: ChatExecutionRootProject;
  projectRoot: string;
  worktree?: ChatExecutionRootWorktree & { root: string };
}): string {
  const payload = value.worktree
    ? {
        version: 1,
        owner: value.owner,
        ref: value.ref,
        project: {
          id: value.project.id,
          root: value.projectRoot,
        },
        worktree: {
          id: value.worktree.id,
          projectSlug: value.worktree.projectSlug,
          root: value.worktree.root,
          createdAt: value.worktree.createdAt,
        },
      }
    : {
        version: 1,
        owner: value.owner,
        ref: value.ref,
        project: {
          id: value.project.id,
          root: value.projectRoot,
        },
      };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createChatExecutionRootResolver<
  Project extends ChatExecutionRootProject,
  Worktree extends ChatExecutionRootWorktree,
>(options: {
  projects: ChatExecutionRootProjectSource<Project>;
  worktrees?: ChatExecutionRootWorktreeSource<Worktree>;
}): ChatExecutionRootResolver {
  if (!options.projects || !options.worktrees) {
    throw new Error("Chat execution-root dependencies are unavailable");
  }
  const worktrees = options.worktrees;

  async function resolve(
    ownerInput: CanonicalOwnerScope,
    refInput: CanonicalChatExecutionRootRef,
  ): Promise<ResolvedChatExecutionRoot> {
    let owner: CanonicalOwnerScope;
    let ref: CanonicalChatExecutionRootRef;
    try {
      owner = CanonicalOwnerScopeSchema.parse(ownerInput);
      ref = CanonicalChatExecutionRootRefSchema.parse(refInput);
    } catch {
      throw new ChatExecutionRootError("invalid_root");
    }
    const ownerScope = projectOwnerScope(owner);
    let projectResult: Awaited<ReturnType<typeof options.projects.getProjectById>>;
    try {
      projectResult = await options.projects.getProjectById(ownerScope, ref.projectId);
    } catch {
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!projectResult.ok) throw dependencyError(projectResult.status);
    const project = projectResult.project;
    if (project.id !== ref.projectId) throw new ChatExecutionRootError("invalid_root");

    let resolvedProjectRoot: string | null;
    try {
      resolvedProjectRoot = await options.projects.resolveProjectWorkingDirectory(project);
    } catch {
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!resolvedProjectRoot) throw new ChatExecutionRootError("invalid_root");
    const projectRoot = await canonicalDirectory(resolvedProjectRoot);
    if (projectRoot !== await canonicalDirectory(project.localPath)) {
      throw new ChatExecutionRootError("invalid_root");
    }

    if (ref.kind === "project") {
      return {
        ref,
        primaryWorkspaceRoot: projectRoot,
        fingerprint: fingerprint({ owner, ref, project, projectRoot }),
      };
    }

    let worktreeResult: Awaited<ReturnType<typeof worktrees.getWorktree>>;
    try {
      worktreeResult = await worktrees.getWorktree(project.slug, ref.worktreeId, ownerScope);
    } catch {
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!worktreeResult.ok) throw dependencyError(worktreeResult.status);
    const worktree = worktreeResult.worktree;
    if (
      worktree.id !== ref.worktreeId
      || worktree.projectSlug !== project.slug
      || !Number.isFinite(Date.parse(worktree.createdAt))
    ) {
      throw new ChatExecutionRootError("invalid_root");
    }
    const worktreeRoot = await canonicalDirectory(worktree.path);
    return {
      ref,
      primaryWorkspaceRoot: worktreeRoot,
      fingerprint: fingerprint({
        owner,
        ref,
        project,
        projectRoot,
        worktree: { ...worktree, root: worktreeRoot },
      }),
    };
  }

  return {
    resolve,
    async revalidate(ownerScope, provenance) {
      if (!/^[a-f0-9]{64}$/.test(provenance.fingerprint)) {
        throw new ChatExecutionRootError("invalid_root");
      }
      const resolved = await resolve(ownerScope, provenance.ref);
      if (resolved.fingerprint !== provenance.fingerprint) {
        throw new ChatExecutionRootError("root_changed");
      }
      return resolved;
    },
  };
}
