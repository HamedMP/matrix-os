import type { ClassificationApi, ClassificationSnapshot } from "./contracts.js";

/** Exact current request only. Never reads a session, file, tool or future message. */
export function extractClassificationSnapshot(api: ClassificationApi, body: string, maxBytes = 16_384): ClassificationSnapshot | null {
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_384 || Buffer.byteLength(body) > 131_072) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch (error) { if (!(error instanceof SyntaxError)) console.warn("[chat-analytics] Snapshot unavailable"); return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let values = api === "openai-responses" ? record.input : record.messages;
  if (api === "openai-responses" && typeof values === "string") values = [{ role: "user", content: values }];
  if (!Array.isArray(values) || values.length > 128) return null;
  const messages: Array<Readonly<{ role: "user" | "assistant"; text: string }>> = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const message = value as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    let text: string;
    if (typeof message.content === "string") text = message.content;
    else if (Array.isArray(message.content) && message.content.length <= 32) {
      text = message.content.flatMap(part => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const candidate = part as Record<string, unknown>;
        return typeof candidate.type === "string" && ["text", "input_text", "output_text"].includes(candidate.type)
          && typeof candidate.text === "string" ? [candidate.text] : [];
      }).join("\n");
    } else continue;
    if (!text.trim()) continue;
    messages.push(Object.freeze({ role: message.role, text }));
    if (messages.length > 32 || Buffer.byteLength(JSON.stringify({ messages })) > maxBytes) return null;
  }
  return messages.length ? Object.freeze({ messages: Object.freeze(messages) }) : null;
}
