import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
  CanonicalChatExecutionRootRefSchema,
  CanonicalOwnerScopeSchema,
  WorktreeIdSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import { PROJECT_SLUG_REGEX } from "../project-registry.js";
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
  /** Gateway-only legacy workspace Provider key derived from ProjectConfig. */
  projectSlug: string;
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

function sameProjectAuthority(
  left: ChatExecutionRootProject,
  right: ChatExecutionRootProject,
): boolean {
  return left.id === right.id
    && left.slug === right.slug
    && left.localPath === right.localPath;
}

function sameWorktreeAuthority(
  left: ChatExecutionRootWorktree,
  right: ChatExecutionRootWorktree,
): boolean {
  return left.id === right.id
    && left.projectSlug === right.projectSlug
    && left.path === right.path
    && left.createdAt === right.createdAt;
}

function isInvalidDirectoryError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES";
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
    if (isInvalidDirectoryError(error)) {
      throw new ChatExecutionRootError("invalid_root");
    }
    throw new ChatExecutionRootError("validation_unavailable");
  }
}

function isWithin(basePath: string, candidatePath: string): boolean {
  const rel = relative(basePath, candidatePath);
  return rel !== ""
    && rel !== ".."
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

async function canonicalManagedWorktreeDirectory(input: {
  homePath: string;
  projectSlug: string;
  worktreeId: string;
  candidatePath: string;
}): Promise<string> {
  const candidate = resolvePath(input.candidatePath);
  const variants = [
    ["worktrees", input.projectSlug, input.worktreeId],
    ["projects", input.projectSlug, "worktrees", input.worktreeId],
  ];
  const segments = variants.find((variant) => join(input.homePath, ...variant) === candidate);
  if (!segments) throw new ChatExecutionRootError("invalid_root");

  const validateChain = async () => {
    let current = input.homePath;
    for (const segment of segments) {
      current = join(current, segment);
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new ChatExecutionRootError("invalid_root");
      }
    }
  };

  try {
    await validateChain();
    const [canonicalHome, canonicalWorktree] = await Promise.all([
      canonicalDirectory(input.homePath),
      realpath(candidate),
    ]);
    await validateChain();
    if (!isWithin(canonicalHome, canonicalWorktree)) {
      throw new ChatExecutionRootError("invalid_root");
    }
    return canonicalWorktree;
  } catch (error: unknown) {
    if (error instanceof ChatExecutionRootError) throw error;
    if (isInvalidDirectoryError(error)) {
      throw new ChatExecutionRootError("invalid_root");
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
  const payload = {
    version: 1,
    owner: value.owner,
    ref: value.ref,
    project: {
      id: value.project.id,
      root: value.projectRoot,
    },
    ...(value.worktree ? {
      worktree: {
        id: value.worktree.id,
        projectSlug: value.worktree.projectSlug,
        root: value.worktree.root,
        createdAt: value.worktree.createdAt,
      },
    } : {}),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createChatExecutionRootResolver<
  Project extends ChatExecutionRootProject,
  Worktree extends ChatExecutionRootWorktree,
>(options: {
  homePath: string;
  projects: ChatExecutionRootProjectSource<Project>;
  worktrees?: ChatExecutionRootWorktreeSource<Worktree>;
}): ChatExecutionRootResolver {
  if (!options.projects || !options.worktrees) {
    throw new Error("Chat execution-root dependencies are unavailable");
  }
  const worktrees = options.worktrees;
  const homePath = resolvePath(options.homePath);

  async function loadProject(ownerScope: OwnerScope, projectId: string): Promise<Project> {
    let projectResult: Awaited<ReturnType<typeof options.projects.getProjectById>>;
    try {
      projectResult = await options.projects.getProjectById(ownerScope, projectId);
    } catch (error: unknown) {
      if (error instanceof ChatExecutionRootError) throw error;
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!projectResult.ok) throw dependencyError(projectResult.status);
    if (projectResult.project.id !== projectId) {
      throw new ChatExecutionRootError("invalid_root");
    }
    return projectResult.project;
  }

  async function loadWorktree(
    ownerScope: OwnerScope,
    projectSlug: string,
    worktreeId: string,
  ): Promise<Worktree> {
    let worktreeResult: Awaited<ReturnType<typeof worktrees.getWorktree>>;
    try {
      worktreeResult = await worktrees.getWorktree(projectSlug, worktreeId, ownerScope);
    } catch (error: unknown) {
      if (error instanceof ChatExecutionRootError) throw error;
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!worktreeResult.ok) throw dependencyError(worktreeResult.status);
    const worktree = worktreeResult.worktree;
    if (
      worktree.id !== worktreeId
      || worktree.projectSlug !== projectSlug
      || !Number.isFinite(Date.parse(worktree.createdAt))
    ) {
      throw new ChatExecutionRootError("invalid_root");
    }
    return worktree;
  }

  async function resolveRoot(
    ownerInput: CanonicalOwnerScope,
    refInput: CanonicalChatExecutionRootRef,
  ): Promise<ResolvedChatExecutionRoot> {
    const parsedOwner = CanonicalOwnerScopeSchema.safeParse(ownerInput);
    const parsedRef = CanonicalChatExecutionRootRefSchema.safeParse(refInput);
    if (!parsedOwner.success || !parsedRef.success) {
      throw new ChatExecutionRootError("invalid_root");
    }
    const owner = parsedOwner.data;
    const ref = parsedRef.data;
    const ownerScope = projectOwnerScope(owner);
    const project = await loadProject(ownerScope, ref.projectId);

    let resolvedProjectRoot: string | null;
    try {
      resolvedProjectRoot = await options.projects.resolveProjectWorkingDirectory(project);
    } catch (error: unknown) {
      if (error instanceof ChatExecutionRootError) throw error;
      throw new ChatExecutionRootError("validation_unavailable");
    }
    if (!resolvedProjectRoot) throw new ChatExecutionRootError("invalid_root");
    const projectRoot = await canonicalDirectory(resolvedProjectRoot);
    if (projectRoot !== await canonicalDirectory(project.localPath)) {
      throw new ChatExecutionRootError("invalid_root");
    }

    if (ref.kind === "project") {
      const currentProject = await loadProject(ownerScope, ref.projectId);
      if (!sameProjectAuthority(project, currentProject)) {
        throw new ChatExecutionRootError("invalid_root");
      }
      return {
        ref,
        primaryWorkspaceRoot: projectRoot,
        projectSlug: currentProject.slug,
        fingerprint: fingerprint({ owner, ref, project: currentProject, projectRoot }),
      };
    }

    if (!PROJECT_SLUG_REGEX.test(project.slug) || !WorktreeIdSchema.safeParse(ref.worktreeId).success) {
      throw new ChatExecutionRootError("invalid_root");
    }

    const worktree = await loadWorktree(ownerScope, project.slug, ref.worktreeId);
    const worktreeRoot = await canonicalManagedWorktreeDirectory({
      homePath,
      projectSlug: project.slug,
      worktreeId: worktree.id,
      candidatePath: worktree.path,
    });
    const currentProject = await loadProject(ownerScope, ref.projectId);
    if (!sameProjectAuthority(project, currentProject)) {
      throw new ChatExecutionRootError("invalid_root");
    }
    // Worktree lookup is slug-addressed, so bracket it with immutable Project authority reads.
    const currentWorktree = await loadWorktree(
      ownerScope,
      currentProject.slug,
      ref.worktreeId,
    );
    if (!sameWorktreeAuthority(worktree, currentWorktree)) {
      throw new ChatExecutionRootError("invalid_root");
    }
    const finalProject = await loadProject(ownerScope, ref.projectId);
    if (!sameProjectAuthority(currentProject, finalProject)) {
      throw new ChatExecutionRootError("invalid_root");
    }
    return {
      ref,
      primaryWorkspaceRoot: worktreeRoot,
      projectSlug: finalProject.slug,
      fingerprint: fingerprint({
        owner,
        ref,
        project: finalProject,
        projectRoot,
        worktree: { ...currentWorktree, root: worktreeRoot },
      }),
    };
  }

  return {
    resolve: resolveRoot,
    async revalidate(ownerScope, provenance) {
      if (!/^[a-f0-9]{64}$/.test(provenance.fingerprint)) {
        throw new ChatExecutionRootError("invalid_root");
      }
      const resolved = await resolveRoot(ownerScope, provenance.ref);
      if (resolved.fingerprint !== provenance.fingerprint) {
        throw new ChatExecutionRootError("root_changed");
      }
      return resolved;
    },
  };
}
