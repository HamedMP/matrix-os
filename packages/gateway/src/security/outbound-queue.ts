import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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
    } catch {
      return [];
    }
  }

  function save(messages: OutboundMessage[]) {
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(messages, null, 2));
    writeFileSync(filePath, readFileSync(tmp, "utf-8"));
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
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
