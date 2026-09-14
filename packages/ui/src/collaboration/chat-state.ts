import {
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationResourceIdSchema,
  CollaborationRuntimeIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const DRAFT_PREFIX = "matrix:collaboration:chat-draft:v1";
const DRAFT_INDEX_KEY = `${DRAFT_PREFIX}:index`;
const DEFAULT_MAX_ENTRIES = 20;
const DraftSchema = z.strictObject({
  text: z.string().max(65_536).refine((value) => new TextEncoder().encode(value).byteLength <= 64 * 1024),
  mode: z.literal("discussion"),
});
const DraftIndexSchema = z.array(z.string().max(1_024).regex(/^matrix:collaboration:chat-draft:v1:/)).max(100);

export interface CollaborationDraft {
  text: string;
  mode: "discussion";
}

export function collaborationDraftKey(input: {
  actorId: string;
  runtimeId: string;
  scopeId: string;
  chatId: string;
}): string {
  const values = [
    CollaborationActorIdSchema.parse(input.actorId),
    CollaborationRuntimeIdSchema.parse(input.runtimeId),
    CollaborationIdSchema.parse(input.scopeId),
    CollaborationResourceIdSchema.parse(input.chatId),
  ];
  return `${DRAFT_PREFIX}:${values.map(encodeURIComponent).join(":")}`;
}

export function createCollaborationDraftStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  options: { maxEntries?: number } = {},
) {
  const maxEntries = z.number().int().min(1).max(50).parse(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  return {
    load(key: string): CollaborationDraft {
      requireDraftKey(key);
      try {
        const raw = storage.getItem(key);
        return raw ? DraftSchema.parse(JSON.parse(raw) as unknown) : emptyDraft();
      } catch (error: unknown) {
        console.warn("[chat-collaboration] private draft load failed", error instanceof Error ? error.name : "UnknownError");
        return emptyDraft();
      }
    },
    save(key: string, value: CollaborationDraft): void {
      requireDraftKey(key);
      const draft = DraftSchema.parse(value);
      try {
        const index = readIndex(storage).filter((entry) => entry !== key);
        index.push(key);
        const evicted = index.splice(0, Math.max(0, index.length - maxEntries));
        for (const entry of evicted) storage.removeItem(entry);
        storage.setItem(key, JSON.stringify(draft));
        storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(index));
      } catch (error: unknown) {
        console.warn("[chat-collaboration] private draft save failed", error instanceof Error ? error.name : "UnknownError");
      }
    },
    clear(key: string): void {
      requireDraftKey(key);
      try {
        storage.removeItem(key);
        storage.setItem(DRAFT_INDEX_KEY, JSON.stringify(readIndex(storage).filter((entry) => entry !== key)));
      } catch (error: unknown) {
        console.warn("[chat-collaboration] private draft clear failed", error instanceof Error ? error.name : "UnknownError");
      }
    },
  };
}

function emptyDraft(): CollaborationDraft {
  return { text: "", mode: "discussion" };
}

function requireDraftKey(key: string): void {
  if (!key.startsWith(`${DRAFT_PREFIX}:`) || key.length > 1_024) throw new Error("Invalid collaboration draft key");
}

function readIndex(storage: Pick<Storage, "getItem">): string[] {
  const raw = storage.getItem(DRAFT_INDEX_KEY);
  if (!raw) return [];
  const parsed = DraftIndexSchema.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : [];
}
