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
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX } from "./project-manager.js";
import {
  containsDeniedFileApiPath,
  isDeniedFileApiPath,
  isProtectedHomeSubpath,
  resolveWithinHome,
} from "./path-security.js";
import { atomicCreateJson, readJsonFile, type OwnerScope } from "./state-ops.js";

type Result<T> = { ok: true; status?: number } & T;
type Failure = { ok: false; status: number; error: { code: string; message: string } };

const FolderNameSchema = z.string().trim().regex(PROJECT_SLUG_REGEX);
const ParentSchema = z.string().trim().min(1).max(1024);
const ClientRequestIdSchema = z.string().min(5).max(132).regex(/^req_[A-Za-z0-9_-]+$/);

interface FolderRequestReceipt {
  fingerprint: string;
  path: string;
  ownerScope: OwnerScope;
  createdAt: string;
}

const MAX_FOLDER_REQUEST_RECEIPTS = 256;
const FOLDER_REQUEST_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

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

  function receiptPath(clientRequestId: string): string {
    return join(homePath, "system", "project-folder-requests", `${clientRequestId}.json`);
  }

  async function pruneReceipts(): Promise<void> {
    const root = join(homePath, "system", "project-folder-requests");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(root, entry.name);
      let stats;
      try {
        stats = await lstat(path);
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      files.push({ path, mtimeMs: stats.mtimeMs });
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const expiredBefore = Date.now() - FOLDER_REQUEST_RECEIPT_TTL_MS;
    const overflow = Math.max(0, files.length - MAX_FOLDER_REQUEST_RECEIPTS + 1);
    await Promise.all(files.map(async (file, index) => {
      if (file.mtimeMs < expiredBefore || index < overflow) await rm(file.path, { force: true });
    }));
  }

  async function readReceipt(clientRequestId: string): Promise<FolderRequestReceipt | null> {
    try {
      const receipt = await readJsonFile<FolderRequestReceipt>(receiptPath(clientRequestId));
      const valid = typeof receipt.fingerprint === "string"
        && typeof receipt.path === "string"
        && typeof receipt.createdAt === "string"
        && (receipt.ownerScope?.type === "user" || receipt.ownerScope?.type === "org")
        && typeof receipt.ownerScope.id === "string";
      if (!valid) return null;

      const createdAtMs = Date.parse(receipt.createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs <= Date.now() - FOLDER_REQUEST_RECEIPT_TTL_MS) {
        await rm(receiptPath(clientRequestId), { force: true });
        return null;
      }
      return receipt;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async function receiptTargetExists(path: string): Promise<boolean> {
    const target = resolveWithinHome(homePath, path);
    if (!target) return false;
    try {
      return (await lstat(target)).isDirectory();
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async function reconcileReceipt(
    clientRequestId: string,
    fingerprint: string,
  ): Promise<Result<{ path: string }> | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const receipt = await readReceipt(clientRequestId);
      if (receipt?.fingerprint === fingerprint && await receiptTargetExists(receipt.path)) {
        return { ok: true, status: 200, path: receipt.path };
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    return null;
  }

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
      const target = join(candidate.path, name);
      if (
        isProtectedHomeSubpath(candidate.base, target)
        || containsDeniedFileApiPath(candidate.base, target)
        || isDeniedFileApiPath(candidate.base, toHomeRelative(candidate.base, target))
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
    async createFolder(input: {
      name: string;
      parent?: string;
      clientRequestId?: string;
      ownerScope?: OwnerScope;
    }): Promise<Result<{ path: string }> | Failure> {
      if (!FolderNameSchema.safeParse(input.name).success) {
        return failure(400, "invalid_folder_name", "Folder name is invalid");
      }
      const parent = input.parent?.trim().replace(/\/+$/, "");
      if (input.clientRequestId && !ClientRequestIdSchema.safeParse(input.clientRequestId).success) {
        return failure(400, "invalid_request", "Folder request is invalid");
      }
      const ownerScope = input.ownerScope ?? { type: "user" as const, id: "local" };
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ name: input.name, parent: parent || "projects", ownerScope }))
        .digest("hex");
      if (input.clientRequestId) {
        const receipt = await readReceipt(input.clientRequestId);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) {
            return failure(409, "request_conflict", "Folder request conflicts with an earlier request");
          }
          if (await receiptTargetExists(receipt.path)) {
            return { ok: true, status: 200, path: receipt.path };
          }
          await rm(receiptPath(input.clientRequestId), { force: true });
        }
        // Preserve an existing replay receipt even when the store is at its
        // cap; reserve room only for a genuinely new receipt.
        await pruneReceipts();
      }

      const result = !parent || parent === "projects"
        ? await createRegistryFolder(input.name)
        : await createNestedFolder(input.name, parent);
      if (!result.ok) {
        if (input.clientRequestId && result.error.code === "folder_conflict") {
          const reconciled = await reconcileReceipt(input.clientRequestId, fingerprint);
          if (reconciled) return reconciled;
        }
        return result;
      }
      if (!input.clientRequestId) return result;

      const published = await atomicCreateJson(receiptPath(input.clientRequestId), {
        fingerprint,
        path: result.path,
        ownerScope,
        createdAt: new Date().toISOString(),
      } satisfies FolderRequestReceipt);
      if (published) return result;
      const receipt = await readReceipt(input.clientRequestId);
      if (receipt?.fingerprint === fingerprint && receipt.path === result.path) {
        return { ok: true, status: 200, path: receipt.path };
      }
      const createdTarget = resolveWithinHome(homePath, result.path);
      if (createdTarget) await rm(createdTarget, { recursive: true, force: true });
      return failure(409, "request_conflict", "Folder request conflicts with an earlier request");
    },
  };
}
