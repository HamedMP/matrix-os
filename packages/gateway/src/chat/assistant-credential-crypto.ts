import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";

const MAX_VALUE_BYTES = 2_048;
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const AssistantCredentialEnvelopeSchema = z.object({
  version: z.literal(1),
  iv: Base64.length(16),
  tag: Base64.length(24),
  data: Base64.min(4).max(2_732),
}).strict();
export type AssistantCredentialEnvelope = z.infer<typeof AssistantCredentialEnvelopeSchema>;

export const SealedAssistantCredentialSchema = z.object({
  occurrenceId: z.string().regex(/^cred_[a-f0-9]{32}$/),
  offset: z.number().int().min(0).max(4_000),
  length: z.union([z.literal("[redacted]".length), z.literal("[redacted credential]".length)]),
  envelope: AssistantCredentialEnvelopeSchema,
}).strict();
export type SealedAssistantCredential = z.infer<typeof SealedAssistantCredentialSchema>;

export type AssistantCredentialBinding = {
  ownerId: string;
  chatId: string;
  runId: string;
  messageId: string;
  occurrenceId: string;
};

/** Must match the canonical Chat message identity used by the orchestrator. */
export function assistantMessageId(runId: string, providerMessageId?: string): string {
  if (!providerMessageId) return `msg_${runId.slice("run_".length)}_assistant`;
  const digest = createHash("sha256").update(`${runId}\0${providerMessageId}`).digest("hex").slice(0, 32);
  return `msg_${digest}`;
}

function aad(binding: AssistantCredentialBinding): Buffer {
  const values = [binding.ownerId, binding.chatId, binding.runId, binding.messageId, binding.occurrenceId];
  if (values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))) {
    throw new Error("Invalid assistant credential binding");
  }
  // Length-prefixed JSON fields prevent ambiguous concatenation.
  return Buffer.from(JSON.stringify(["matrix-assistant-credential", 1, ...values]), "utf8");
}

function decodeBase64(value: string, expectedLength?: number): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    throw new Error("Invalid assistant credential envelope");
  }
  return bytes;
}

export function assistantCredentialOccurrenceId(messageId: string, offset: number): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(messageId) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid assistant credential occurrence");
  }
  const digest = createHash("sha256").update(`matrix-assistant-credential-id:v1:${messageId}:${offset}`).digest("hex").slice(0, 32);
  return `cred_${digest}`;
}

export function sealAssistantCredential(
  key: Buffer,
  binding: AssistantCredentialBinding,
  value: string,
): AssistantCredentialEnvelope {
  const bytes = Buffer.from(value, "utf8");
  if (key.length !== 32 || bytes.length === 0 || bytes.length > MAX_VALUE_BYTES || value.includes("\0")) {
    throw new Error("Invalid assistant credential");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(binding));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function openAssistantCredential(
  key: Buffer,
  binding: AssistantCredentialBinding,
  unknownEnvelope: unknown,
): string {
  if (key.length !== 32) throw new Error("Invalid assistant credential key");
  const envelope = AssistantCredentialEnvelopeSchema.parse(unknownEnvelope);
  const iv = decodeBase64(envelope.iv, 12);
  const tag = decodeBase64(envelope.tag, 16);
  const data = decodeBase64(envelope.data);
  if (data.length === 0 || data.length > MAX_VALUE_BYTES) throw new Error("Invalid assistant credential envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  if (plaintext.length === 0 || plaintext.length > MAX_VALUE_BYTES) throw new Error("Invalid assistant credential envelope");
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
}
