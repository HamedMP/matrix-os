/**
 * `bot_workspace` execution roots (spec 536, research R4). A bot's private
 * workspace is `<home>/bots/<botId>`, derived server-side from the owner and
 * the bot ID and never from client or model input. Every path component is
 * checked with lstat so no symbolic link is followed, and the fingerprint
 * covers the directory's device and inode: a workspace that is deleted and
 * recreated, or swapped for another directory, no longer matches.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  CanonicalOwnerScopeSchema,
  ChatAgentIdSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import { ChatExecutionRootError, type ResolvedChatExecutionRoot } from "./execution-root.js";

type BotWorkspaceRef = Extract<CanonicalChatExecutionRootRef, { kind: "bot_workspace" }>;

export const BOT_WORKSPACES_DIRECTORY = "bots";

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A real directory reached without following links, or `invalid_root`. */
async function realDirectory(path: string): Promise<{ dev: bigint; ino: bigint }> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ChatExecutionRootError("invalid_root");
    return { dev: stats.dev, ino: stats.ino };
  } catch (error: unknown) {
    if (error instanceof ChatExecutionRootError) throw error;
    if (isMissing(error)) throw new ChatExecutionRootError("invalid_root");
    throw new ChatExecutionRootError("validation_unavailable");
  }
}

function personalOwner(ownerInput: CanonicalOwnerScope): CanonicalOwnerScope {
  const owner = CanonicalOwnerScopeSchema.safeParse(ownerInput);
  // Bots are personal in M1; an organization never owns a private bot workspace.
  if (!owner.success || owner.data.type !== "personal") throw new ChatExecutionRootError("invalid_root");
  return owner.data;
}

export function botWorkspacePath(homePath: string, botId: string): string {
  if (!ChatAgentIdSchema.safeParse(botId).success) throw new ChatExecutionRootError("invalid_root");
  return join(resolvePath(homePath), BOT_WORKSPACES_DIRECTORY, botId);
}

export function botWorkspaceFingerprint(input: { owner: CanonicalOwnerScope; botId: string; dev: bigint; ino: bigint }): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    owner: input.owner,
    kind: "bot_workspace",
    botId: input.botId,
    dev: input.dev.toString(),
    ino: input.ino.toString(),
  })).digest("hex");
}

/** Resolves and fingerprints a bot workspace; the directory must already exist. */
export async function resolveBotWorkspaceRoot(input: {
  homePath: string;
  owner: CanonicalOwnerScope;
  ref: BotWorkspaceRef;
}): Promise<ResolvedChatExecutionRoot> {
  const owner = personalOwner(input.owner);
  const path = botWorkspacePath(input.homePath, input.ref.botId);
  const home = resolvePath(input.homePath);
  await realDirectory(home);
  await realDirectory(join(home, BOT_WORKSPACES_DIRECTORY));
  const workspace = await realDirectory(path);
  return {
    ref: input.ref,
    primaryWorkspaceRoot: path,
    fingerprint: botWorkspaceFingerprint({ owner, botId: input.ref.botId, ...workspace }),
  };
}

/**
 * Creates a bot's workspace exclusively, inside the reserved creation
 * operation. An existing workspace is an error: the caller decides whether
 * a retry with the same bot ID may reuse it after checking it is empty.
 */
export async function createBotWorkspace(input: { homePath: string; botId: string }): Promise<string> {
  const home = resolvePath(input.homePath);
  await realDirectory(home);
  const root = join(home, BOT_WORKSPACES_DIRECTORY);
  try {
    await mkdir(root, { mode: 0o750 });
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
  }
  await realDirectory(root);
  const path = botWorkspacePath(input.homePath, input.botId);
  await mkdir(path, { mode: 0o750 });
  await realDirectory(path);
  return path;
}
