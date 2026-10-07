/**
 * Concrete bot tools behind the broker (spec 536). Artifacts are text files
 * in the bot's own workspace. Before any effect the workspace is resolved
 * again and must match the fingerprint bound at admission; every path
 * segment is checked without following links, and files are opened with
 * O_NOFOLLOW. Questions, memory, and integrations go to their services.
 * Capabilities without a tool yet are refused as `not_granted`.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BOT_ARTIFACT_MAX_BYTES, type BotToolRequest, type BotToolResult } from "@matrix-os/contracts";
import { BotAdmissionError } from "./admission.js";
import { ChatExecutionRootError } from "../chat/execution-root.js";
import { resolveBotWorkspaceRoot } from "../chat/bot-workspace-root.js";
import type { BotEffectClass } from "./database.js";
import { BotBrokerActionError, type BotToolDispatcher } from "./broker-actions.js";
import type { BotInteractionService } from "./interactions.js";
import type { BotIntegrationTools } from "./integration-tools.js";
import type { BotMemoryService } from "./memory-service.js";
import { getAction } from "../integrations/registry.js";
import { isManagedPiBinding, type PiRuntimeBinding } from "./runtime-registry.js";

const MAX_TEXT_PART_CHARS = 60 * 1024;
/**
 * Saves are staged in this workspace directory and renamed over their file,
 * so a failed save never damages the old one. The directory is reserved:
 * artifact paths cannot name it.
 */
export const BOT_SAVE_STAGING = ".bot-save";
/** One server-owned namespace covers Chat and project roots, including crash leftovers. */
export const MANAGED_SAVE_STAGING = ".managed-chat-save";
const TEMP_NAME = /^[a-f0-9-]{36}\.tmp$/;
const TEMP_TTL_MS = 15 * 60_000;
const MAX_SWEEP_ENTRIES = 256;
const MAX_SWEPT_WORKSPACES = 128;
const MAX_SWEEP_CURSORS = 256;
/** Bounded cursors let recurring passes reach entries beyond one pass's work budget. */
const sweepOffsets = new Map<string, number>();
const SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000]{1,255}$/;

function scanOffset(directory: string): number {
  return sweepOffsets.get(directory) ?? 0;
}

function rememberScanOffset(directory: string, offset: number): void {
  sweepOffsets.delete(directory);
  if (offset <= 0) return;
  if (sweepOffsets.size >= MAX_SWEEP_CURSORS) sweepOffsets.delete(sweepOffsets.keys().next().value!);
  sweepOffsets.set(directory, offset);
}

const EFFECTS: Record<BotToolRequest["capability"], BotEffectClass> = {
  "agent.task": "write",
  "artifact.read": "read",
  "artifact.write": "write",
  "integration.inventory": "read",
  "integration.call": "write",
  "integration.describe": "read",
  "mcp.inventory": "read",
  "mcp.describe": "read",
  "mcp.call": "write",
  "memory.search": "read",
  "memory.propose": "write",
  "interaction.create": "write",
};

function isCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

function isPrivateStaging(info: Stats): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0
    && (typeof process.getuid !== "function" || info.uid === process.getuid());
}

function segments(relPath: string): string[] {
  const parts = relPath.split("/");
  if (parts.length === 0 || parts.length > 16 || !parts.every((part) => SEGMENT.test(part)) || parts[0] === BOT_SAVE_STAGING) {
    throw new BotBrokerActionError("invalid_arguments");
  }
  return parts;
}

/** Walks to the file's directory without following links, creating it when asked. */
async function directoryFor(root: string, parts: readonly string[], create: boolean): Promise<string> {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new BotBrokerActionError("invalid_arguments");
    } catch (error: unknown) {
      if (error instanceof BotBrokerActionError) throw error;
      if (!isCode(error, "ENOENT") || !create) throw new BotBrokerActionError("invalid_arguments");
      await mkdir(current, { mode: 0o750 });
    }
  }
  return current;
}

/**
 * Removes staged saves a process left when it stopped mid-save. Processes a
 * bounded number per pass, resuming on the next pass without following links.
 */
async function sweepStaging(directory: string, now: number, privateDirectory = false): Promise<void> {
  let entries;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (privateDirectory && !isPrivateStaging(info))) return;
    entries = await opendir(directory);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT", "ENOTDIR")) return;
    throw error;
  }
  const offset = scanOffset(directory);
  let skipped = 0;
  let seen = 0;
  let removed = 0;
  for await (const entry of entries) {
    if (skipped < offset) { skipped += 1; continue; }
    if (++seen > MAX_SWEEP_ENTRIES) break;
    if (!TEMP_NAME.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > TEMP_TTL_MS) {
        await unlink(path);
        removed += 1;
      }
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) console.warn("[bots] stale save cleanup failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }
  rememberScanOffset(directory, seen > MAX_SWEEP_ENTRIES && skipped === offset
    ? Math.max(0, offset + MAX_SWEEP_ENTRIES - removed) : 0);
}

/**
 * The recurring cleanup covers the server-owned managed Chat staging directory
 * and every bot workspace. Each scan is bounded, continuing from the next entry
 * on later passes. Staged links and linked staging directories are skipped.
 */
export async function sweepBotWorkspaceSaves(homePath: string, now = Date.now()): Promise<void> {
  try {
    const homeInfo = await lstat(homePath);
    if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) return;
  } catch (error: unknown) {
    if (isCode(error, "ENOENT", "ENOTDIR")) return;
    throw error;
  }
  await sweepStaging(join(homePath, MANAGED_SAVE_STAGING), now, true);
  const root = join(homePath, "bots");
  let workspaces;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    workspaces = await opendir(root);
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  const offset = scanOffset(root);
  let skipped = 0;
  let seen = 0;
  for await (const entry of workspaces) {
    if (skipped < offset) { skipped += 1; continue; }
    if (++seen > MAX_SWEPT_WORKSPACES) break;
    if (!entry.isDirectory() || !/^bot_[a-z0-9]{8,64}$/.test(entry.name)) continue;
    await sweepStaging(join(root, entry.name, BOT_SAVE_STAGING), now);
  }
  rememberScanOffset(root, seen > MAX_SWEPT_WORKSPACES && skipped === offset ? offset + MAX_SWEPT_WORKSPACES : 0);
}

async function removeStagedSave(temp: string): Promise<void> {
  await unlink(temp).catch((cleanup: unknown) => {
    if (!isCode(cleanup, "ENOENT")) console.warn("[bots] failed save cleanup failed:", cleanup instanceof Error ? cleanup.name : "UnknownError");
  });
}

function textResult(text: string): BotToolResult {
  const content: Array<{ type: "text"; text: string }> = [];
  for (let index = 0; index < Math.max(1, text.length); index += MAX_TEXT_PART_CHARS) {
    content.push({ type: "text", text: text.slice(index, index + MAX_TEXT_PART_CHARS) });
  }
  return { ok: true, content };
}

export function createBotToolDispatcher(deps: {
  homePath: string;
  managedTools?: import("../chat/managed-pi-owner-tools.js").ManagedPiOwnerTools;
  managedWorkspace?: (binding: import("./runtime-registry.js").ManagedPiRuntimeBinding) => Promise<string>;
  /** Recheck live source after staging, immediately before artifact publication. */
  assertSource?: (binding: PiRuntimeBinding, signal: AbortSignal) => Promise<void>;
  interactions?: Pick<BotInteractionService, "createFromTool">;
  memory?: Pick<BotMemoryService, "propose" | "search">;
  integrations?: Pick<BotIntegrationTools, "inventory" | "call">;
  nativeTask?: { prepare(binding: PiRuntimeBinding): Promise<void>; execute(binding: PiRuntimeBinding, prompt: string, cwd: string, signal: AbortSignal): Promise<BotToolResult> };
}): BotToolDispatcher {
  async function workspace(binding: PiRuntimeBinding): Promise<string> {
    try {
      if (isManagedPiBinding(binding)) {
        if (!deps.managedWorkspace) throw new BotBrokerActionError("not_granted");
        return await deps.managedWorkspace(binding);
      }
      const root = await resolveBotWorkspaceRoot({
        homePath: deps.homePath,
        owner: { type: "personal", ownerId: binding.ownerId },
        ref: { kind: "bot_workspace", botId: binding.botId },
      });
      // A workspace that was replaced since admission is not the one this run may touch.
      if (root.fingerprint !== binding.rootFingerprint) throw new BotBrokerActionError("stale_generation");
      return root.primaryWorkspaceRoot;
    } catch (error: unknown) {
      if (error instanceof BotBrokerActionError) throw error;
      if (error instanceof BotAdmissionError) throw new BotBrokerActionError(error.code === "root_changed" || error.code === "not_found" ? "stale_generation" : "unavailable");
      if (error instanceof ChatExecutionRootError) throw new BotBrokerActionError("unavailable");
      throw error;
    }
  }

  async function write(binding: PiRuntimeBinding, request: Extract<BotToolRequest, { capability: "artifact.write" }>, signal: AbortSignal): Promise<BotToolResult> {
    // Revision-checked replacement needs artifact revisions; a plain save overwrites.
    if (request.args.replace) throw new BotBrokerActionError("invalid_arguments");
    const parts = segments(request.args.relPath);
    const root = await workspace(binding);
    const directory = await directoryFor(root, parts, true);
    const target = join(directory, parts.at(-1)!);
    const managed = isManagedPiBinding(binding);
    if (!managed) {
      try {
        const existing = await lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink()) throw new BotBrokerActionError("invalid_arguments");
      } catch (error: unknown) {
        if (error instanceof BotBrokerActionError) throw error;
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
    const staging = join(managed ? deps.homePath : root, managed ? MANAGED_SAVE_STAGING : BOT_SAVE_STAGING);
    if (managed) {
      const homeInfo = await lstat(deps.homePath);
      if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new BotBrokerActionError("unavailable");
    }
    try {
      await mkdir(staging, { mode: managed ? 0o700 : 0o750 });
    } catch (error: unknown) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const stagingInfo = await lstat(staging);
    if (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink() || (managed && !isPrivateStaging(stagingInfo))) {
      throw new BotBrokerActionError("unavailable");
    }
    await sweepStaging(staging, Date.now(), managed);
    const temp = join(staging, `${randomUUID()}.tmp`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    try {
      try {
        await file.writeFile(request.args.content, "utf8");
        if (managed) await file.sync();
      } finally {
        await file.close();
      }
      if (managed) {
        // Revalidate authority/root after staging, before the first owner-visible effect.
        if (await workspace(binding) !== root || await directoryFor(root, parts, false) !== directory) {
          throw new BotBrokerActionError("stale_generation");
        }
        // link is an atomic exclusive publication: existing files/links always win.
        // Never remove the target on error: publication may have happened before a
        // lost acknowledgement. Its bytes are complete; the broker retains uncertainty.
        await deps.assertSource?.(binding, signal);
        try { await link(temp, target); }
        catch (error: unknown) {
          if (isCode(error, "EEXIST", "ELOOP")) throw new BotBrokerActionError("invalid_arguments");
          throw error;
        }
        const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parent.sync(); } finally { await parent.close(); }
      } else {
        // Staging/close may finish after native credentials were removed or replaced.
        await deps.assertSource?.(binding, signal);
        await rename(temp, target);
      }
    } catch (error: unknown) {
      await removeStagedSave(temp);
      throw error;
    }
    if (managed) await removeStagedSave(temp);
    return textResult(`Saved ${request.args.relPath} (${Buffer.byteLength(request.args.content, "utf8")} bytes).`);
  }

  async function read(binding: PiRuntimeBinding, request: Extract<BotToolRequest, { capability: "artifact.read" }>): Promise<BotToolResult> {
    const parts = segments(request.args.relPath);
    const directory = await directoryFor(await workspace(binding), parts, false);
    let file;
    try {
      file = await open(join(directory, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT", "ELOOP", "EISDIR")) throw new BotBrokerActionError("invalid_arguments");
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > BOT_ARTIFACT_MAX_BYTES) throw new BotBrokerActionError("invalid_arguments");
      const buffer = Buffer.alloc(BOT_ARTIFACT_MAX_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > BOT_ARTIFACT_MAX_BYTES) throw new BotBrokerActionError("invalid_arguments");
      return textResult(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  }

  return {
    effectClass: (request) => request.capability === "integration.call" && getAction(request.args.service, request.args.action)?.risk === "read" ? "read" : EFFECTS[request.capability],
    async prepare(binding, request, signal) {
      if (request.capability === 'agent.task') {
        if (!deps.nativeTask || isManagedPiBinding(binding)) throw new BotBrokerActionError('not_granted');
        await deps.nativeTask.prepare(binding); return;
      }
      if (isManagedPiBinding(binding) && !request.capability.startsWith("artifact.")) {
        if (!deps.managedTools) throw new BotBrokerActionError("not_granted");
        await deps.managedTools.prepare(binding, request, signal);
      }
    },
    async dispatch(binding, request, signal) {
      if (request.capability === 'agent.task') {
        if (!deps.nativeTask || isManagedPiBinding(binding)) throw new BotBrokerActionError('not_granted');
        return { result: await deps.nativeTask.execute(binding, request.args.prompt, await workspace(binding), signal) };
      }
      if (request.capability === "artifact.write") {
        // Paths may hold characters the checkpoint reference does not allow; the digest names the file.
        const outcomeRef = `artifact:${createHash("sha256").update(request.args.relPath).digest("hex").slice(0, 32)}`;
        return { result: await write(binding, request, signal), outcomeRef };
      }
      if (request.capability === "artifact.read") return { result: await read(binding, request) };
      if (isManagedPiBinding(binding)) {
        if (!deps.managedTools) throw new BotBrokerActionError("not_granted");
        return { result: await deps.managedTools.dispatch(binding, request, signal) };
      }
      if (request.capability === "interaction.create" && deps.interactions) {
        return { result: await deps.interactions.createFromTool(binding, request.args) };
      }
      if (request.capability === "memory.propose" && deps.memory) return { result: await deps.memory.propose(binding, request.args) };
      if (request.capability === "memory.search" && deps.memory) return { result: await deps.memory.search(binding, request.args) };
      if (request.capability === "integration.inventory" && deps.integrations) {
        return { result: await deps.integrations.inventory(binding, request.args, signal) };
      }
      if (request.capability === "integration.call" && deps.integrations) {
        return { result: await deps.integrations.call(binding, request.args, signal) };
      }
      throw new BotBrokerActionError("not_granted");
    },
  };
}
