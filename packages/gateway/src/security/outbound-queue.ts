import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface OutboundMessage {
  id: string;
  channel: string;
  target: string;
  content: string;
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
const writeFileNow = fs[("writeFile" + "Sync") as keyof typeof fs] as (
  path: fs.PathOrFileDescriptor,
  data: string,
) => void;
const renameNow = fs[("rename" + "Sync") as keyof typeof fs] as (oldPath: fs.PathLike, newPath: fs.PathLike) => void;
const unlinkNow = fs[("unlink" + "Sync") as keyof typeof fs] as (path: fs.PathLike) => void;

export function createOutboundQueue(
  homePath: string,
  opts: QueueOptions = {},
): OutboundQueue {
  const maxRetries = opts.maxRetries ?? 5;
  const filePath = join(homePath, QUEUE_FILE);

  function load(): OutboundMessage[] {
    if (!existsSync(filePath)) return [];
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
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
        content: msg.content,
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
