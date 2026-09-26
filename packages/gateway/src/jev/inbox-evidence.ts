import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { HermesJevScope } from "../chat/hermes-integration-capability.js";
import { JevInboxGmailIdSchema } from "@matrix-os/contracts";

export const GmailId = JevInboxGmailIdSchema;
const Thread = z.object({ id: GmailId, historyId: z.string().min(1).max(160),
  messages: z.array(z.object({ id: GmailId, internalDate: z.string().regex(/^\d{1,16}$/) })).min(1).max(512) });
const Message = z.object({ id: GmailId, threadId: GmailId, internalDate: z.string().regex(/^\d{1,16}$/),
  snippet: z.string().max(4096).optional(), payload: z.unknown() });
const Part = z.object({ mimeType: z.string().max(128), filename: z.string().max(1024).optional(),
  headers: z.array(z.object({ name: z.string().max(128), value: z.string().max(4096) })).max(128).optional(),
  body: z.object({ data: z.string().max(12 * 1024).optional(), attachmentId: z.string().max(160).optional() }).optional(),
  parts: z.array(z.unknown()).max(32).optional() });

export function threadIdentity(raw: unknown, expectedId: string) {
  const parsed = Thread.parse(raw);
  if (parsed.id !== expectedId || new Set(parsed.messages.map((m) => m.id)).size !== parsed.messages.length) {
    throw new Error("Invalid thread evidence");
  }
  const ordered = parsed.messages.map((message) => ({ ...message, timestamp: Number(message.internalDate) }));
  if (ordered.some((message) => !Number.isSafeInteger(message.timestamp))) throw new Error("Invalid thread evidence");
  ordered.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { id: parsed.id, historyId: parsed.historyId, messageIds: ordered.map((m) => m.id),
    internalDates: ordered.map((m) => m.internalDate) };
}

/** Only complete, bounded plain text is paid evidence. HTML/attachments are never fetched. */
function plainText(raw: unknown): string {
  let visited = 0;
  const texts: string[] = [];
  function walk(candidate: unknown, depth: number): void {
    if (++visited > 64 || depth > 8) throw new Error("Incomplete message evidence");
    const metadata = Part.pick({ mimeType: true, filename: true }).parse(candidate);
    if (metadata.filename || (!metadata.mimeType.toLowerCase().startsWith("multipart/") && metadata.mimeType.toLowerCase() !== "text/plain")) return;
    const part = Part.parse(candidate);
    if (part.mimeType.toLowerCase() === "text/plain") {
      const data = part.body?.data;
      if (!data || part.body?.attachmentId || !/^[A-Za-z0-9_-]+={0,2}$/.test(data)) throw new Error("Incomplete message evidence");
      const bytes = Buffer.from(data, "base64url");
      if (bytes.length > 8192) throw new Error("Message evidence too large");
      texts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n").normalize("NFC"));
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  }
  walk(raw, 0);
  const text = texts.join("\n");
  if (!text.trim() || Buffer.byteLength(text) > 8192) throw new Error("Incomplete message evidence");
  return text;
}

export function assembleInboxEvidence(ownerId: string, scope: HermesJevScope, threadId: string,
  expectedIds: string[], rawMessages: unknown[], now: number, expectedDates?: string[]) {
  const messages = rawMessages.map((raw, index) => {
    const message = Message.parse(raw);
    const timestamp = Number(message.internalDate);
    if ((expectedDates && message.internalDate !== expectedDates[index]) || message.id !== expectedIds[index] || message.threadId !== threadId || !Number.isSafeInteger(timestamp)
      || timestamp < 0 || timestamp > now + 300_000) throw new Error("Invalid message evidence");
    const headers = Part.parse(message.payload).headers ?? [];
    const header = (name: string) => headers.filter((h) => h.name.toLowerCase() === name)
      .map((h) => h.value.normalize("NFC").replace(/\r\n?/g, "\n")).join("\n");
    return { id: message.id, threadId, internalDate: message.internalDate, from: header("from"), to: header("to"),
      date: header("date"), subject: header("subject"), snippet: message.snippet ?? "", plainText: plainText(message.payload) };
  });
  if (messages.length < 1 || messages.length > 4 || messages.length !== expectedIds.length) throw new Error("Incomplete evidence");
  const state = JSON.stringify({ version: "email-triage-evidence-v1",
    expectedEmail: scope.account.expectedEmail, threadId, mode: "full", complete: true, messages });
  if (Buffer.byteLength(state) > 32 * 1024) throw new Error("Evidence too large");
  const hash = createHash("sha256").update("email-triage-evidence-v1\0")
    .update(JSON.stringify([ownerId, scope.runId, scope.agentId, scope.revision, scope.account])).update("\0").update(state).digest("hex");
  return { state, hash, ageDays: Math.max(0, (now - Math.max(...messages.map((m) => Number(m.internalDate)))) / 86_400_000),
    messageCount: messages.length };
}
