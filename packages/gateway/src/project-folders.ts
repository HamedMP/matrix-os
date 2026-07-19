// Exclusive folder creation for the desktop add-project flow. Mirrors
// project-manager.ts patterns: zod-validated names, home-scoped path
// resolution with symlink/protected-subtree guards, atomic mkdir for
// conflict semantics, and generic client-facing errors with server-side
// logging. Two layouts are supported:
//   - default ("projects" root): projects/<name>/repo, the same checkout
//     layout scratch projects use, so the result can be bound as a folder
//     project (the registry only allows projects/<slug>/repo bindings);
//   - custom parent: <parent>/<name> anywhere else non-protected in the
//     home. The projects registry itself is manager-owned metadata and is
//     rejected as a custom parent.
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX } from "./project-manager.js";
import {
  containsDeniedFileApiPath,
  isProtectedHomeSubpath,
  resolveWithinHome,
} from "./path-security.js";

type Result<T> = { ok: true; status?: number } & T;
type Failure = { ok: false; status: number; error: { code: string; message: string } };

const FolderNameSchema = z.string().trim().regex(PROJECT_SLUG_REGEX);
const ParentSchema = z.string().trim().min(1).max(1024);

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function toHomeRelative(homePath: string, target: string): string {
  return relative(homePath, target).split(sep).join("/");
}

// True when `path` is `root`, inside it, or an ancestor of it.
function overlapsRoot(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return true;
  const toRoot = relative(path, root);
  return toRoot === "" || (!toRoot.startsWith("..") && !isAbsolute(toRoot));
}

export function createProjectFolders(options: { homePath: string }) {
  const homePath = resolve(options.homePath);

  // Creates projects/<name>/repo atomically: mkdir without recursive fails
  // with EEXIST when the slug slot is taken, so a conflict can never
  // overwrite an existing project. The slot is rolled back if the inner
  // checkout dir cannot be created.
  async function createRegistryFolder(name: string): Promise<Result<{ path: string }> | Failure> {
    const projectsRoot = join(homePath, "projects");
    const slotPath = join(projectsRoot, name);
    const repoPath = join(slotPath, "repo");
    try {
      await mkdir(projectsRoot, { recursive: true });
      await mkdir(slotPath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
        return failure(409, "folder_conflict", "A folder with that name already exists");
      }
      console.warn("[project-folders] Failed to create project slot:", err instanceof Error ? err.message : err);
      return failure(500, "folder_create_failed", "The folder could not be created");
    }
    try {
      await mkdir(repoPath);
    } catch (err: unknown) {
      console.warn("[project-folders] Failed to create checkout dir:", err instanceof Error ? err.message : err);
      await rm(slotPath, { recursive: true, force: true });
      return failure(500, "folder_create_failed", "The folder could not be created");
    }
    return { ok: true, status: 201, path: toHomeRelative(homePath, repoPath) };
  }

  async function createNestedFolder(name: string, parent: string): Promise<Result<{ path: string }> | Failure> {
    if (!ParentSchema.safeParse(parent).success) {
      return failure(400, "invalid_parent", "Parent folder is invalid");
    }
    const resolvedParent = resolveWithinHome(homePath, parent);
    if (!resolvedParent) {
      return failure(400, "invalid_parent", "Parent folder is invalid");
    }
    let realParent: string;
    let realHome: string;
    try {
      const stats = await lstat(resolvedParent);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        return failure(400, "invalid_parent", "Parent folder is invalid");
      }
      [realParent, realHome] = await Promise.all([realpath(resolvedParent), realpath(homePath)]);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return failure(400, "invalid_parent", "Parent folder is invalid");
      }
      console.warn("[project-folders] Failed to inspect parent:", err instanceof Error ? err.message : err);
      return failure(400, "invalid_parent", "Parent folder is invalid");
    }
    // Check the lexical path AND the fully resolved path against the same
    // rules so a symlinked ancestor cannot alias a protected subtree. The
    // projects registry is manager-owned metadata (config.json, sibling
    // projects): creating loose folders inside it would squat on slug
    // namespaces, so only the default registry layout may write there.
    for (const candidate of [
      { base: homePath, path: resolvedParent },
      { base: realHome, path: realParent },
    ]) {
      if (
        isProtectedHomeSubpath(candidate.base, candidate.path)
        || containsDeniedFileApiPath(candidate.base, candidate.path)
        || overlapsRoot(join(candidate.base, "projects"), candidate.path)
      ) {
        return failure(400, "invalid_parent", "Parent folder is invalid");
      }
    }
    const target = join(realParent, name);
    try {
      await mkdir(target);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
        return failure(409, "folder_conflict", "A folder with that name already exists");
      }
      console.warn("[project-folders] Failed to create folder:", err instanceof Error ? err.message : err);
      return failure(500, "folder_create_failed", "The folder could not be created");
    }
    // The home itself may be symlinked (macOS /var -> /private/var), so the
    // logical home-relative path is computed against the resolved home.
    return { ok: true, status: 201, path: toHomeRelative(realHome, target) };
  }

  return {
    async createFolder(input: { name: string; parent?: string }): Promise<Result<{ path: string }> | Failure> {
      if (!FolderNameSchema.safeParse(input.name).success) {
        return failure(400, "invalid_folder_name", "Folder name is invalid");
      }
      const parent = input.parent?.trim().replace(/\/+$/, "");
      if (!parent || parent === "projects") {
        return createRegistryFolder(input.name);
      }
      return createNestedFolder(input.name, parent);
    },
  };
}
