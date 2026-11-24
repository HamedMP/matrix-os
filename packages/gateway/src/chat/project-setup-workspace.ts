import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { pinDirectory, isFsError, type PinnedDirectory } from "../app-gallery/pinned-directory.js";
import { createProjectAgentConfigFile } from "../project-agent-context.js";
import type { ChatExecutionRootResolver } from "./execution-root.js";
import type { ChatOwner } from "./records.js";
import { ProjectSetupError } from "./project-setup-state.js";

export interface ProjectSetupWorkspace {
  fingerprint: string;
  executionRootFingerprint: string;
  projectSlug: string;
  read(path: string): Promise<string | null>;
  create(path: string, content: string): Promise<void>;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

async function readManifest(directory: PinnedDirectory, path: string): Promise<string | null> {
  const parts = path.split("/");
  const name = parts.shift()!;
  try {
    if (parts.length === 0) return new TextDecoder("utf-8", { fatal: true }).decode(await directory.readFile(name, 64 * 1024, { singleLink: true }));
    const child = await directory.child(name);
    try { return await readManifest(child, parts.join("/")); }
    finally { await child.close(); }
  } catch (error: unknown) {
    if (isFsError(error, "ENOENT")) return null;
    throw error;
  }
}

export function projectSetupWorkspaceFingerprint(rootFingerprint: string, identity: { dev: number; ino: number }): string {
  return createHash("sha256").update(`${rootFingerprint}:${identity.dev}:${identity.ino}`).digest("hex");
}

export async function openProjectSetupWorkspace(roots: ChatExecutionRootResolver, homePath: string, owner: ChatOwner, projectId: string): Promise<ProjectSetupWorkspace> {
  if (owner.type !== "personal") throw new ProjectSetupError("not_found");
  const resolved = await roots.resolve(owner, { kind: "project", projectId });
  const homeRelative = relative(await realpath(homePath), resolved.primaryWorkspaceRoot);
  if (!resolved.projectSlug || !homeRelative || isAbsolute(homeRelative) || homeRelative === ".." || homeRelative.startsWith("../")) throw new ProjectSetupError("not_found");
  const directory = await pinDirectory(resolved.primaryWorkspaceRoot);
  try {
    const identity = await directory.identity();
    const fingerprint = projectSetupWorkspaceFingerprint(resolved.fingerprint, identity);
    const revalidate = async () => {
      const current = await roots.revalidate(owner, resolved);
      const stat = await lstat(current.primaryWorkspaceRoot);
      if (current.primaryWorkspaceRoot !== resolved.primaryWorkspaceRoot || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new ProjectSetupError("not_found");
    };
    await revalidate();
    return { fingerprint, executionRootFingerprint: resolved.fingerprint, projectSlug: resolved.projectSlug, revalidate, close: () => directory.close(),
      read: path => readManifest(directory, path),
      create: async (path, content) => { await revalidate(); await createProjectAgentConfigFile(directory, path, content); await revalidate(); } };
  } catch (error: unknown) {
    await directory.close();
    throw error;
  }
}
