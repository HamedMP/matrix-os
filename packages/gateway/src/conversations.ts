import * as fs from "node:fs";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  GlobalChatProviderIdSchema,
  type GlobalChatProviderId,
  type KernelConversationId,
} from "@matrix-os/contracts";
import {
  createConversationMutationLock,
  type ConversationMutationLock,
} from "./conversation-mutation-lock.js";
import { atomicCreateJson } from "./state-ops.js";

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
}

export interface ConversationFile {
  id: string;
  providerId?: GlobalChatProviderId;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  context?: ConversationContext;
}

export interface ConversationContext {
  projectId: string;
}

export interface ConversationMeta {
  id: string;
  providerId: GlobalChatProviderId;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  context?: ConversationContext;
}

export interface SearchResult {
  sessionId: string;
  messageIndex: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  preview: string;
}

export interface ConversationStore {
  begin(sessionId: string, providerId?: GlobalChatProviderId): void;
  addUserMessage(sessionId: string, content: string): void;
  addSystemMessage(sessionId: string, content: string): void;
  appendAssistantText(sessionId: string, text: string): void;
  addToolStart(sessionId: string, tool: string): void;
  addToolEnd(sessionId: string, tool: string, input?: Record<string, unknown>): void;
  finalize(sessionId: string, onFinalized?: () => void): Promise<void>;
  list(): ConversationMeta[];
  get(id: string): ConversationFile | null;
  create(channel?: string, providerId?: GlobalChatProviderId): string;
  rekey(
    id: KernelConversationId,
    providerSessionId: KernelConversationId,
  ): Promise<"moved" | "not_found" | "conflict">;
  updateContext(
    id: KernelConversationId,
    projectId: string | null,
    isActive?: () => boolean,
  ): Promise<"updated" | "not_found" | "busy">;
  delete(
    id: KernelConversationId,
    isActive?: () => boolean,
  ): Promise<"deleted" | "not_found" | "busy">;
  search(query: string, opts?: { limit?: number }): SearchResult[];
}

const CONVERSATION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ACTIVE_CONVERSATIONS = 20;
const MAX_CONVERSATION_MUTATION_KEYS = 64;

export function createConversationStore(
  homePath: string,
  options: { mutationLock?: ConversationMutationLock } = {},
): ConversationStore {
  const dir = join(homePath, "system", "conversations");
  mkdirSync(dir, { recursive: true });
  const active = new Map<string, ConversationFile>();
  const buffers = new Map<string, string>();
  const lastTouched = new Map<string, number>();
  const mutationLock = options.mutationLock ?? createConversationMutationLock({
    maxKeys: MAX_CONVERSATION_MUTATION_KEYS,
  });

  function evictStale() {
    const now = Date.now();
    for (const [id, ts] of lastTouched) {
      if (now - ts > CONVERSATION_IDLE_TTL_MS) {
        active.delete(id);
        buffers.delete(id);
        lastTouched.delete(id);
      }
    }
    while (active.size > MAX_ACTIVE_CONVERSATIONS) {
      let oldestId: string | undefined;
      let oldestTs = Infinity;
      for (const [id, ts] of lastTouched) {
        if (ts < oldestTs) { oldestTs = ts; oldestId = id; }
      }
      if (!oldestId) break;
      active.delete(oldestId);
      buffers.delete(oldestId);
      lastTouched.delete(oldestId);
    }
  }

  function touch(id: string) {
    lastTouched.set(id, Date.now());
  }

  function flushAssistantBuffer(sessionId: string, conv: ConversationFile) {
    const buffered = buffers.get(sessionId);
    if (!buffered) return;
    conv.messages.push({ role: "assistant", content: buffered, timestamp: Date.now() });
    buffers.delete(sessionId);
  }
  const writeFileNow = fs.writeFileSync as (
    path: fs.PathOrFileDescriptor,
    data: string,
  ) => void;

  function filePath(id: string) {
    return join(dir, `${id}.json`);
  }

  function writeToDisk(conv: ConversationFile) {
    try {
      writeFileNow(filePath(conv.id), JSON.stringify(conv, null, 2));
    } catch (err: unknown) {
      console.warn("[conversations] Could not persist conversation:", err instanceof Error ? err.message : String(err));
    }
  }

  async function writeToDiskAtomically(conv: ConversationFile): Promise<void> {
    const targetPath = filePath(conv.id);
    const temporaryPath = join(dir, `.${conv.id}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify(conv, null, 2), "utf-8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, targetPath);
    } catch (error: unknown) {
      if (handle) {
        try {
          await handle.close();
        } catch (closeError: unknown) {
          console.warn("[conversations] Could not close failed context write:", closeError);
        }
      }
      try {
        await unlink(temporaryPath);
      } catch (cleanupError: unknown) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
          console.warn("[conversations] Could not clean failed context write:", cleanupError);
        }
      }
      throw error;
    }
  }

  function readFromDisk(id: string): ConversationFile | null {
    const path = filePath(id);
    if (!existsSync(path)) return null;
    const conversation = JSON.parse(readFileSync(path, "utf-8")) as ConversationFile;
    return {
      ...conversation,
      providerId: GlobalChatProviderIdSchema.catch("claude").parse(conversation.providerId),
    };
  }

  return {
    begin(sessionId, providerId = "claude") {
      evictStale();
      const existing = readFromDisk(sessionId);
      if (existing) {
        active.set(sessionId, existing);
        touch(sessionId);
        return;
      }

      const now = Date.now();
      const conv: ConversationFile = {
        id: sessionId,
        providerId,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      active.set(sessionId, conv);
      touch(sessionId);
    },

    addUserMessage(sessionId, content) {
      const conv = active.get(sessionId);
      if (!conv) return;

      conv.messages.push({ role: "user", content, timestamp: Date.now() });
      conv.updatedAt = Date.now();
      touch(sessionId);
      writeToDisk(conv);
    },

    addSystemMessage(sessionId, content) {
      const conv = active.get(sessionId);
      if (!conv) return;

      flushAssistantBuffer(sessionId, conv);
      conv.messages.push({ role: "system", content, timestamp: Date.now() });
      conv.updatedAt = Date.now();
      touch(sessionId);
      writeToDisk(conv);
    },

    appendAssistantText(sessionId, text) {
      const current = buffers.get(sessionId) ?? "";
      buffers.set(sessionId, current + text);
      // Refresh TTL on every streaming chunk: a long assistant turn (>30 min
      // of tool use + text) would otherwise be evicted mid-stream by the next
      // begin()/create() call, dropping the in-memory buffer before
      // finalize() can persist it.
      touch(sessionId);
    },

    addToolStart(sessionId, tool) {
      const conv = active.get(sessionId);
      if (!conv) return;

      flushAssistantBuffer(sessionId, conv);

      conv.messages.push({
        role: "system",
        content: `Using ${tool}...`,
        tool,
        timestamp: Date.now(),
      });
      conv.updatedAt = Date.now();
      touch(sessionId);
      writeToDisk(conv);
    },

    addToolEnd(sessionId, tool, input) {
      const conv = active.get(sessionId);
      if (!conv) return;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const m = conv.messages[i];
        if (m.tool === tool && m.content.startsWith("Using ")) {
          // Replace the message with a fresh object instead of mutating in
          // place. CLAUDE.md "Never mutate state in reducers": shallow copies
          // can share refs and in-place mutation causes streaming text
          // duplication elsewhere in the system.
          conv.messages[i] = { ...m, content: `Used ${tool}`, toolInput: input };
          break;
        }
      }
      conv.updatedAt = Date.now();
      touch(sessionId);
      writeToDisk(conv);
    },

    finalize(sessionId, onFinalized) {
      return mutationLock.run(sessionId, async () => {
        const conv = active.get(sessionId);
        if (!conv) {
          onFinalized?.();
          return;
        }

        const buffered = buffers.get(sessionId);
        if (buffered) {
          conv.messages.push({
            role: "assistant",
            content: buffered,
            timestamp: Date.now(),
          });
          buffers.delete(sessionId);
          conv.updatedAt = Date.now();
        }

        writeToDisk(conv);
        active.delete(sessionId);
        lastTouched.delete(sessionId);
        onFinalized?.();
      });
    },

    list() {
      if (!existsSync(dir)) return [];

      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      return files.map((f) => {
        const id = f.replace(".json", "");
        const conv = readFromDisk(id)!;
        const firstUser = conv.messages.find((m) => m.role === "user");
        return {
          id: conv.id,
          providerId: conv.providerId ?? "claude",
          preview: firstUser?.content ?? "",
          messageCount: conv.messages.length,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          ...(conv.context ? { context: conv.context } : {}),
        };
      });
    },

    get(id) {
      const cached = active.get(id);
      if (cached) return cached;
      return readFromDisk(id);
    },

    create(channel?, providerId = "claude") {
      evictStale();
      const uuid = randomUUID();
      const id = channel ? `${channel}:${uuid}` : uuid;
      const now = Date.now();
      const conv: ConversationFile = {
        id,
        providerId,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      active.set(id, conv);
      touch(id);
      writeToDisk(conv);
      return id;
    },

    rekey(id, providerSessionId) {
      return mutationLock.run(id, async () => {
        const current = active.get(id) ?? readFromDisk(id);
        if (!current) return "not_found";
        if (id === providerSessionId) return "moved";

        const providerPath = filePath(providerSessionId);
        const sourcePath = filePath(id);
        const transferPath = join(dir, `.${id}.${randomUUID()}.transfer`);
        const next: ConversationFile = { ...current, id: providerSessionId };
        let sourceMoved = false;
        let targetWritten = false;
        try {
          await rename(sourcePath, transferPath);
          sourceMoved = true;
          if (!await atomicCreateJson(providerPath, next)) {
            await rename(transferPath, sourcePath);
            sourceMoved = false;
            return "conflict";
          }
          targetWritten = true;
          await unlink(transferPath);
        } catch (error: unknown) {
          if (targetWritten) {
            try {
              await unlink(providerPath);
            } catch (cleanupError: unknown) {
              if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) {
                console.warn("[conversations] Could not roll back provider session record:", cleanupError);
              }
            }
          }
          if (sourceMoved) {
            try {
              await rename(transferPath, sourcePath);
            } catch (rollbackError: unknown) {
              console.error("[conversations] Could not restore pending conversation record:", rollbackError);
            }
          }
          throw error;
        }

        if (active.has(id)) {
          active.delete(id);
          active.set(providerSessionId, next);
        }
        const buffered = buffers.get(id);
        if (buffered !== undefined) {
          buffers.delete(id);
          buffers.set(providerSessionId, buffered);
        }
        const touchedAt = lastTouched.get(id);
        lastTouched.delete(id);
        if (touchedAt !== undefined) lastTouched.set(providerSessionId, touchedAt);
        return "moved";
      });
    },

    updateContext(id, projectId, isActive) {
      return mutationLock.run(id, async () => {
        if (isActive?.()) return "busy";
        const current = active.get(id) ?? readFromDisk(id);
        if (!current) return "not_found";

        const { context: _previousContext, ...record } = current;
        const next: ConversationFile = {
          ...record,
          updatedAt: Date.now(),
          ...(projectId ? { context: { projectId } } : {}),
        };
        await writeToDiskAtomically(next);
        if (active.has(id)) {
          active.set(id, next);
          touch(id);
        }
        return "updated";
      });
    },

    delete(id, isActive) {
      const path = filePath(id);
      return mutationLock.run(id, async () => {
        if (isActive?.()) {
          return "busy";
        }

        let stats: fs.Stats;
        try {
          stats = await lstat(path);
        } catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return "not_found";
          }
          throw error;
        }

        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error("conversation record is not a regular file");
        }

        await unlink(path);
        active.delete(id);
        buffers.delete(id);
        lastTouched.delete(id);
        return "deleted";
      });
    },

    search(query, opts?) {
      if (!existsSync(dir)) return [];
      const limit = opts?.limit ?? Infinity;
      const lowerQuery = query.toLowerCase();
      const results: SearchResult[] = [];

      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const id = f.replace(".json", "");
        const conv = readFromDisk(id);
        if (!conv) continue;

        for (let i = 0; i < conv.messages.length; i++) {
          const msg = conv.messages[i];
          if (msg.content.toLowerCase().includes(lowerQuery)) {
            results.push({
              sessionId: conv.id,
              messageIndex: i,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
              preview: msg.content.length > 100
                ? msg.content.slice(0, 100) + "..."
                : msg.content,
            });
          }
        }
      }

      results.sort((a, b) => b.timestamp - a.timestamp);
      return results.slice(0, limit);
    },
  };
}
