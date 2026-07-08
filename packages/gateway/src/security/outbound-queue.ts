import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

export interface OutboundMessage {
  id: string;
  channel: string;
  target: string;
  ownerId?: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface OutboundQueue {
  enqueue(msg: Omit<OutboundMessage, "id" | "createdAt" | "attempts">): string;
  ack(id: string): void;
  failed(id: string, error: string): void;
  pending(): OutboundMessage[];
}

interface QueueOptions {
  maxRetries?: number;
}

const QUEUE_FILE = "system/outbound-queue.json";
const SAFE_QUEUE_OWNER_ID = /^[A-Za-z0-9_-]{1,256}$/;
const QUEUE_METADATA_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const QueueMetadataValueSchema = z.union([
  z.string().max(160),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const QueueMetadataSchema = z.record(z.string().regex(QUEUE_METADATA_KEY), QueueMetadataValueSchema);
const OutboundMessageSchema = z.object({
  id: z.string().min(1).max(128),
  channel: z.string().min(1).max(32),
  target: z.string().min(1).max(512),
  ownerId: z.string().regex(SAFE_QUEUE_OWNER_ID).optional(),
  content: z.string().max(16_384),
  metadata: QueueMetadataSchema.optional(),
  createdAt: z.number().finite(),
  attempts: z.number().int().min(0).max(100),
  lastError: z.string().max(512).optional(),
}).strict();
const OutboundMessagesSchema = z.array(OutboundMessageSchema).max(1000);
const writeFileNow = fs.writeFileSync as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;
const renameNow = fs.renameSync as (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
const unlinkNow = fs.unlinkSync as (path: fs.PathLike) => void;

export function createOutboundQueue(
  homePath: string,
  opts: QueueOptions = {},
): OutboundQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const filePath = join(homePath, QUEUE_FILE);

  function load(): OutboundMessage[] {
    if (!existsSync(filePath)) return [];
    try {
      const parsed = OutboundMessagesSchema.safeParse(JSON.parse(readFileSync(filePath, "utf-8")));
      if (!parsed.success) {
        console.warn("[outbound-queue] Could not load queue: invalid queue file");
        return [];
      }
      return parsed.data;
    } catch (err: unknown) {
      console.warn("[outbound-queue] Could not load queue:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  function save(messages: OutboundMessage[]) {
    const tmp = filePath + ".tmp";
    try {
      writeFileNow(tmp, JSON.stringify(messages, null, 2));
      renameNow(tmp, filePath);
    } catch (err: unknown) {
      console.warn("[outbound-queue] Could not persist queue:", err instanceof Error ? err.message : String(err));
      try {
        if (existsSync(tmp)) unlinkNow(tmp);
      } catch (cleanupErr: unknown) {
          console.warn(
            "[outbound-queue] Could not remove temporary queue file:",
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          );
      }
    }
  }

  return {
    enqueue(msg) {
      const messages = load();
      const entry: OutboundMessage = {
        id: randomUUID(),
        channel: msg.channel,
        target: msg.target,
        ownerId: msg.ownerId,
        content: msg.content,
        metadata: msg.metadata,
        createdAt: Date.now(),
        attempts: 0,
      };
      messages.push(entry);
      save(messages);
      return entry.id;
    },

    ack(id) {
      const messages = load().filter((m) => m.id !== id);
      save(messages);
    },

    failed(id, error) {
      const messages = load();
      const msg = messages.find((m) => m.id === id);
      if (!msg) return;
      msg.attempts++;
      msg.lastError = error;
      if (msg.attempts >= maxRetries) {
        save(messages.filter((m) => m.id !== id));
      } else {
        save(messages);
      }
    },

    pending() {
      return load();
    },
  };
}
