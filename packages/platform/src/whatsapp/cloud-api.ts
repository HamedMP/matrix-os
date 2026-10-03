import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { isWhatsAppSenderAllowed, isWhatsAppSenderEligible, WhatsAppBsuidSchema, WhatsAppPhoneSchema, type WhatsAppConfig } from "./config.js";

export { isWhatsAppSenderAllowed, isWhatsAppSenderEligible } from "./config.js";
export interface WhatsAppMessage {
  id: string;
  sender: string;
  phone?: string;
  timestamp: number;
  type: string;
  text?: string;
}

/** A malformed or over-limit provider event, distinct from operational faults. */
export class WhatsAppInvalidEventError extends Error {
  constructor() {
    super("Invalid WhatsApp event");
    this.name = "WhatsAppInvalidEventError";
  }
}

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MESSAGES = 100;
const messageId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._=+/-]+$/);
const boundedString = z.string().max(4096);
const messageSchema = z.object({
  id: messageId,
  from: WhatsAppPhoneSchema.optional(),
  from_user_id: WhatsAppBsuidSchema.optional(),
  timestamp: z.string().regex(/^\d{1,11}$/).transform(Number).refine((value) => value > 0),
  type: z.string().min(1).max(64).regex(/^[a-z_]+$/),
  text: z.object({ body: boundedString.min(1) }).optional(),
}).refine((message) => message.type !== "text" || message.text !== undefined)
  .refine((message) => message.from !== undefined || message.from_user_id !== undefined);
const envelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: z.string().min(1).max(64),
    changes: z.array(z.object({
      field: z.string().min(1).max(64),
      value: z.object({
        messaging_product: z.literal("whatsapp").optional(),
        metadata: z.object({
          phone_number_id: z.string().min(1).max(64),
          display_phone_number: z.string().max(32).optional(),
        }).optional(),
        messages: z.array(messageSchema).max(MAX_MESSAGES).optional(),
      }),
    })).max(20),
  })).max(20),
});

export function verifyWhatsAppSignature(raw: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

// Unknown payload fields remain acceptable for forwards compatibility, but all
// values, including media/status metadata we ignore, share the same hard bounds.
function hasBoundedValues(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 5000 || depth > 12) return false;
  if (typeof value === "string") return value.length <= 4096;
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => hasBoundedValues(item, depth + 1, budget));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= 100 && entries.every(([key, item]) => key.length <= 128 && hasBoundedValues(item, depth + 1, budget));
  }
  return value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export function parseWhatsAppMessages(raw: string, phoneNumberId: string): WhatsAppMessage[] {
  const invalid = () => new WhatsAppInvalidEventError();
  if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) {
    if (error instanceof SyntaxError) throw invalid();
    throw error;
  }
  if (!hasBoundedValues(value)) throw invalid();
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const result: WhatsAppMessage[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages" || change.value.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const message of change.value.messages ?? []) {
        if (result.length >= MAX_MESSAGES) throw invalid();
        result.push({
          id: message.id, sender: message.from_user_id ?? message.from!, type: message.type, timestamp: message.timestamp,
          ...(message.from ? { phone: message.from } : {}),
          ...(message.type === "text" ? { text: message.text!.body } : {}),
        });
      }
    }
  }
  return result;
}

export function isWhatsAppReplyWindowOpen(timestamp: number, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(nowMs)) return false;
  const ageSeconds = nowMs / 1000 - timestamp;
  return ageSeconds >= -300 && ageSeconds < 24 * 60 * 60;
}

export function canAdmitWhatsAppMessage(config: WhatsAppConfig, message: WhatsAppMessage, nowMs = Date.now()): boolean {
  const explicitlyAdmitted = isWhatsAppSenderAllowed(config, message.sender)
    || (WhatsAppBsuidSchema.safeParse(message.sender).success && message.phone !== undefined
      && isWhatsAppSenderAllowed(config, message.phone));
  return isWhatsAppSenderEligible(message.sender) && explicitlyAdmitted
    && isWhatsAppReplyWindowOpen(message.timestamp, nowMs);
}

export class WhatsAppSendError extends Error {
  constructor(readonly ambiguous: boolean) {
    super("WhatsApp delivery failed");
    this.name = "WhatsAppSendError";
  }
}

const sendResponseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  messages: z.array(z.object({ id: messageId })).length(1),
  contacts: z.array(z.object({
    input: z.string().max(131), wa_id: WhatsAppPhoneSchema.optional(), user_id: WhatsAppBsuidSchema.optional(),
  })).max(1).optional(),
});

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new WhatsAppSendError(true);
  const reader = response.body.getReader();
  let bytes = 0;
  let result = "";
  let complete = false;
  const decoder = new TextDecoder("utf8", { fatal: true });
  const abort = () => { void reader.cancel().catch((error: unknown) => {
    console.error("WhatsApp response cleanup failed", error instanceof Error ? error.name : "UnknownError");
  }); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new WhatsAppSendError(true);
      }
      result += decoder.decode(next.value, { stream: true });
    }
    const decoded = result + decoder.decode();
    complete = true;
    return decoded;
  } finally {
    signal.removeEventListener("abort", abort);
    // Decode/read failures may leave the remote stream open. Cancel while its
    // reader still holds the lock; releasing alone does not close the response.
    if (!complete) abort();
    reader.releaseLock();
  }
}

export async function sendWhatsAppText(config: WhatsAppConfig, to: string, text: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!isWhatsAppSenderAllowed(config, to) || !boundedString.min(1).safeParse(text).success) throw new WhatsAppSendError(false);
  // No retries: a connection failure may happen after the provider accepted it.
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual",
        ...(WhatsAppBsuidSchema.safeParse(to).success ? { recipient: to } : { to }),
        type: "text", text: { preview_url: false, body: text },
      }),
    });
    if (!response.ok) {
      if (response.body) void response.body.cancel().catch((error: unknown) => {
        console.error("WhatsApp rejected-response cleanup failed", error instanceof Error ? error.name : "UnknownError");
      });
      throw new WhatsAppSendError(false);
    }
    const raw = await readBoundedResponse(response, signal);
    const parsed = sendResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new WhatsAppSendError(true);
    return parsed.data.messages[0].id;
  } catch (error) {
    if (error instanceof WhatsAppSendError) throw error;
    throw new WhatsAppSendError(true);
  }
}
