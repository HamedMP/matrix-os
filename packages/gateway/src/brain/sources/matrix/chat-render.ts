/**
 * Matrix chat source: turning committed messages into day documents. A day group starts at a message and takes every
 * following message whose UTC day is not later than the group's day, so groups only depend on the message order.
 * Each group renders into parts of at most chatPartMaxBytes; a group over the per-day caps keeps its first messages
 * and the rest of that day is read past without being stored (items_truncated).
 */
import { cleanText, isoInstant, readThrough } from "./shared.js";
import {
  BRAIN_MATRIX_LIMITS, type BrainMatrixChatMessage, type BrainMatrixChatOwner, type BrainMatrixChatReader,
} from "./types.js";

const L = BRAIN_MATRIX_LIMITS;
/** Messages a group may fetch from its first message to its lookahead, in whole reader calls. */
export const CHAT_GROUP_FETCH_MAX = Math.ceil((L.chatMessagesPerDay + 1) / L.chatMessagesPerCall) * L.chatMessagesPerCall;

/** Messages of one chat after a seq, fetched in bounded calls and counted against the page's read budget. */
export class ChatMessageQueue {
  private buffer: BrainMatrixChatMessage[] = [];
  private fetchedSeq: number;
  private exhausted = false;
  consumedSeq: number;

  constructor(
    private readonly reader: BrainMatrixChatReader, private readonly owner: BrainMatrixChatOwner,
    private readonly chatId: string, afterSeq: number, private readonly reads: { fetched: number },
  ) {
    this.fetchedSeq = afterSeq;
    this.consumedSeq = afterSeq;
  }

  /** The next message, null at the end of the chat, "budget" when the page may not read more. */
  async peek(): Promise<BrainMatrixChatMessage | null | "budget"> {
    if (this.buffer.length === 0 && !this.exhausted) {
      if (this.reads.fetched >= L.chatReadsPerPage) return "budget";
      const batch = await readThrough("chat messages read", () => this.reader.getMessages(
        this.owner, this.chatId, { afterSeq: this.fetchedSeq, limit: L.chatMessagesPerCall },
      ));
      this.reads.fetched += batch.length;
      const ordered = batch.filter((message) => message.seq > this.fetchedSeq).slice(0, L.chatMessagesPerCall);
      if (ordered.length > 0) this.fetchedSeq = ordered[ordered.length - 1]!.seq;
      if (batch.length < L.chatMessagesPerCall || ordered.length === 0) this.exhausted = true;
      this.buffer = ordered;
    }
    return this.buffer[0] ?? null;
  }

  /** Consumes the message the last peek returned. */
  take(): void {
    this.consumedSeq = this.buffer.shift()!.seq;
  }
}

/** The message time as a UTC instant; a malformed time sorts as the epoch. */
function messageAt(message: BrainMatrixChatMessage): string {
  return isoInstant(message.createdAt) ?? "1970-01-01T00:00:00.000Z";
}

export function messageDay(message: BrainMatrixChatMessage): string {
  return messageAt(message).slice(0, 10);
}

export interface ChatPart {
  readonly lines: string[];
  bytes: number;
  readonly participants: string[];
  lastAt: string;
}
export interface ChatGroup {
  readonly day: string;
  readonly parts: ChatPart[];
  truncated: boolean;
  /** False when the page's read budget ended while reading past the rest of a truncated day. */
  complete: boolean;
}

function messageLine(message: BrainMatrixChatMessage): string | null {
  if (message.state !== "committed" || (message.role !== "user" && message.role !== "assistant")) return null;
  const text = cleanText(message.parts.flatMap((part) => (part.type === "text" && typeof part.text === "string"
    ? [part.text] : [])).join("\n")).trim();
  if (text === "") return null;
  const time = messageAt(message).slice(11, 16);
  // A cut through an emoji would leave half of it, which the store refuses: the half is dropped.
  let cut = text.slice(0, L.chatMessageMaxChars);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `[${time}] ${message.role}: ${cut}`;
}

function addMessage(group: ChatGroup, message: BrainMatrixChatMessage, ownerId: string): void {
  const line = messageLine(message);
  if (line === null) return;
  const bytes = Buffer.byteLength(line, "utf8") + 1;
  let part = group.parts[group.parts.length - 1];
  if (part === undefined || part.bytes + bytes > L.chatPartMaxBytes) {
    if (group.parts.length >= L.chatPartsPerDay) {
      group.truncated = true;
      return;
    }
    part = { lines: [], bytes: 0, participants: [], lastAt: "" };
    group.parts.push(part);
  }
  part.lines.push(line);
  part.bytes += bytes;
  part.lastAt = messageAt(message);
  const person = `matrix:${message.actorId ?? ownerId}`;
  if (message.role === "user" && !part.participants.includes(person) && part.participants.length < 50) {
    part.participants.push(person);
  }
}

/** Reads one day group starting at the queue's next message (which must exist). */
export async function readChatGroup(queue: ChatMessageQueue, first: BrainMatrixChatMessage, ownerId: string) {
  const group: ChatGroup = { day: messageDay(first), parts: [], truncated: false, complete: true };
  let count = 0;
  for (let next: BrainMatrixChatMessage | null | "budget" = first; ; next = await queue.peek()) {
    if (next === null) return group;
    if (next === "budget") {
      group.truncated = true;
      group.complete = false;
      return group;
    }
    if (next !== first && messageDay(next) > group.day) return group;
    queue.take();
    count += 1;
    if (count > L.chatMessagesPerDay) group.truncated = true;
    if (!group.truncated) addMessage(group, next, ownerId);
  }
}

/** Reads past every message of a truncated day; false when the read budget ended first. */
export async function skipChatDay(queue: ChatMessageQueue, day: string): Promise<boolean> {
  for (;;) {
    const next = await queue.peek();
    if (next === "budget") return false;
    if (next === null || messageDay(next) > day) return true;
    queue.take();
  }
}
