/**
 * Concrete bot tools behind the broker (spec 536). Artifacts are text files
 * in the bot's own workspace. Before any effect the workspace is resolved
 * again and must match the fingerprint bound at admission; every path
 * segment is checked without following links, and files are opened with
 * O_NOFOLLOW. Capabilities without a tool yet are refused as `not_granted`.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { BOT_ARTIFACT_MAX_BYTES, type BotToolRequest, type BotToolResult } from "@matrix-os/contracts";
import { ChatExecutionRootError } from "../chat/execution-root.js";
import { resolveBotWorkspaceRoot } from "../chat/bot-workspace-root.js";
import type { BotEffectClass } from "./database.js";
import { BotBrokerActionError, type BotToolDispatcher } from "./broker-actions.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

const MAX_TEXT_PART_CHARS = 60 * 1024;
/** Saves write here first, then rename over the file, so a failed save never damages the old one. */
const TEMP_PREFIX = ".bot-save-";
const TEMP_NAME = /^\.bot-save-[a-f0-9-]{36}\.tmp$/;
const TEMP_TTL_MS = 15 * 60_000;
const MAX_SWEEP_ENTRIES = 256;
const SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000]{1,255}$/;

const EFFECTS: Record<BotToolRequest["capability"], BotEffectClass> = {
  "artifact.read": "read",
  "artifact.write": "write",
  "integration.inventory": "read",
  "integration.call": "write",
  "memory.search": "read",
  "memory.propose": "write",
  "interaction.create": "write",
};

function isCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

function segments(relPath: string): string[] {
  const parts = relPath.split("/");
  if (parts.length === 0 || parts.length > 16 || !parts.every((part) => SEGMENT.test(part))) {
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
 * Removes this directory's save files left by a process that stopped
 * mid-save. Runs before each save, reads a bounded number of entries, and
 * never follows or removes a link.
 */
async function sweepStaleSaves(directory: string, now: number): Promise<void> {
  const entries = await opendir(directory);
  let seen = 0;
  try {
    for await (const entry of entries) {
      if (++seen > MAX_SWEEP_ENTRIES) break;
      if (!TEMP_NAME.test(entry.name)) continue;
      const path = join(directory, entry.name);
      try {
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink() && now - info.mtimeMs > TEMP_TTL_MS) await unlink(path);
      } catch (error: unknown) {
        if (!isCode(error, "ENOENT")) console.warn("[bots] stale save cleanup failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  } catch (error: unknown) {
    // Breaking out of the loop closes the directory; anything else is logged, not fatal to the save.
    if (!isCode(error, "ERR_DIR_CLOSED")) console.warn("[bots] stale save scan failed:", error instanceof Error ? error.name : "UnknownError");
  }
}

function textResult(text: string): BotToolResult {
  const content: Array<{ type: "text"; text: string }> = [];
  for (let index = 0; index < Math.max(1, text.length); index += MAX_TEXT_PART_CHARS) {
    content.push({ type: "text", text: text.slice(index, index + MAX_TEXT_PART_CHARS) });
  }
  return { ok: true, content };
}

export function createBotToolDispatcher(deps: { homePath: string }): BotToolDispatcher {
  async function workspace(binding: BotRuntimeBinding): Promise<string> {
    try {
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
      if (error instanceof ChatExecutionRootError) throw new BotBrokerActionError("unavailable");
      throw error;
    }
  }

  async function write(binding: BotRuntimeBinding, request: Extract<BotToolRequest, { capability: "artifact.write" }>): Promise<BotToolResult> {
    // Revision-checked replacement needs artifact revisions; a plain save overwrites.
    if (request.args.replace) throw new BotBrokerActionError("invalid_arguments");
    const parts = segments(request.args.relPath);
    const directory = await directoryFor(await workspace(binding), parts, true);
    const target = join(directory, parts.at(-1)!);
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new BotBrokerActionError("invalid_arguments");
    } catch (error: unknown) {
      if (error instanceof BotBrokerActionError) throw error;
      if (!isCode(error, "ENOENT")) throw error;
    }
    await sweepStaleSaves(directory, Date.now());
    const temp = join(directory, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
    try {
      try {
        await file.writeFile(request.args.content, "utf8");
      } finally {
        await file.close();
      }
      await rename(temp, target);
    } catch (error: unknown) {
      await unlink(temp).catch((cleanup: unknown) => {
        if (!isCode(cleanup, "ENOENT")) console.warn("[bots] failed save cleanup failed:", cleanup instanceof Error ? cleanup.name : "UnknownError");
      });
      throw error;
    }
    return textResult(`Saved ${request.args.relPath} (${Buffer.byteLength(request.args.content, "utf8")} bytes).`);
  }

  async function read(binding: BotRuntimeBinding, request: Extract<BotToolRequest, { capability: "artifact.read" }>): Promise<BotToolResult> {
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
    effectClass: (request) => EFFECTS[request.capability],
    async dispatch(binding, request) {
      if (request.capability === "artifact.write") {
        // Paths may hold characters the checkpoint reference does not allow; the digest names the file.
        const outcomeRef = `artifact:${createHash("sha256").update(request.args.relPath).digest("hex").slice(0, 32)}`;
        return { result: await write(binding, request), outcomeRef };
      }
      if (request.capability === "artifact.read") return { result: await read(binding, request) };
      throw new BotBrokerActionError("not_granted");
    },
  };
}
