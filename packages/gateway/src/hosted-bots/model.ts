// Adapted for the Matrix private preview from OpenMausBot v0.1.150
// server/setup-mode.ts and server/drivers/openai-responses.ts (Apache-2.0).
// Copyright 2026 Milind Soni and OpenMausBot contributors. See upstream/NOTICE.
import { z } from "zod/v4";
import { readBoundedBody, discard } from "../collaboration/scope-runtime-broker.js";
import { HostedBotsError, type ModelInput, type ModelResult } from "./contracts.js";

const API_ORIGIN = "https://api.openai.com/v1";
const MODEL = "gpt-4.1-mini";
const REQUEST_TIMEOUT_MS = 50_000;
const SETUP_COMMAND = /^\/setup(?:\s+|$)([\s\S]*)$/i;

const ProfileSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(8_000),
}).strict();
const ProviderResultSchema = z.object({
  status: z.literal("completed"),
  output: z.array(z.object({ type: z.string() }).passthrough()).max(16),
});

const proposeProfile = {
  type: "function",
  name: "propose_profile",
  description: "Update your Bot's standing instructions using the user's explicit configuration. The change will be reversible.",
  strict: true,
  parameters: {
    type: "object",
    properties: { reason: { type: "string" }, instructions: { type: "string" } },
    required: ["reason", "instructions"],
    additionalProperties: false,
  },
} as const;

function setupTurnText(text: string) {
  const match = text.trim().match(SETUP_COMMAND);
  if (!match) return text;
  const request = match[1]?.trim();
  return request ? "Set yourself up for this job: " + request
    : "Set yourself up. Ask me what you need to know, then propose your configuration.";
}

const setupPrompt = "The user explicitly asked you to set yourself up. Ask at most four questions that change what you would "
  + "build. Ask only for missing choices, not an extra yes for already-requested actions. Explain what you intend to "
  + "do and what you will not do. Once the requirements are clear, use propose_profile for your own standing instructions. "
  + "Do not invent access to schedules, external services, files, accounts or tools. A proposal can only change your own "
  + "standing instructions. Explain what remains for the user to do by hand.";
const basePrompt = "You are a Matrix Bot. Give useful answers based on the conversation. This preview cannot use files, "
  + "shell, schedules, browser or external app actions. Never claim to have performed those actions.";

type ProviderItem = z.infer<typeof ProviderResultSchema>["output"][number];

function assistantText(items: readonly ProviderItem[]): string {
  const pieces = items.flatMap((item) => item.type === "message" && Array.isArray(item.content)
    ? item.content.flatMap((content: unknown) => {
      if (typeof content !== "object" || content === null || !("type" in content)) return [];
      if (content.type === "output_text" && "text" in content && typeof content.text === "string") return [content.text];
      if (content.type === "refusal" && "refusal" in content && typeof content.refusal === "string") return [content.refusal];
      return [];
    }) : []);
  const text = pieces.join("\n\n").trim();
  if (!text || text.length > 16_000) throw new Error("Invalid Bot response");
  return text;
}

async function responses(fetcher: typeof fetch, apiKey: string, body: object, signal: AbortSignal) {
  const response = await fetcher(API_ORIGIN + "/responses", {
    method: "POST", redirect: "error", headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await discard(response);
    throw new Error("Bot model request failed");
  }
  return ProviderResultSchema.parse(JSON.parse(await readBoundedBody(response, 1024 * 1024))).output;
}

export async function verifyOpenMausPreviewModelKey(apiKey: string) {
  const response = await fetch(API_ORIGIN + "/models/" + MODEL, {
    redirect: "error", headers: { Authorization: "Bearer " + apiKey }, signal: AbortSignal.timeout(10_000),
  });
  await discard(response);
  if (!response.ok) throw new HostedBotsError("model_required");
}

export function createOpenMausPreviewModel(options: { readKey: () => Promise<string | null>; fetch?: typeof fetch }) {
  const fetcher = options.fetch ?? fetch;
  return async (input: ModelInput, signal: AbortSignal): Promise<ModelResult> => {
    const apiKey = await options.readKey();
    if (!apiKey) throw new HostedBotsError("model_required");
    const instructions = [basePrompt, input.mode === "setup" ? setupPrompt : "", input.instructions].filter(Boolean).join("\n\n");
    const messages = input.messages.map((message, index) => ({
      role: message.role,
      content: input.mode === "setup" && index === input.messages.length - 1 ? setupTurnText(message.text) : message.text,
    }));
    // Responses requests are stateless. Tool replay forwards the response output and its correlated call id.
    const request = { model: MODEL, instructions, store: false, max_output_tokens: 2048, parallel_tool_calls: false, input: messages,
      tools: input.mode === "setup" ? [proposeProfile] : [] };
    const output = await responses(fetcher, apiKey, request, signal);
    const calls = output.filter((item) => item.type === "function_call");
    if (calls.length === 0) return { text: assistantText(output) };
    const call = calls[0];
    if (input.mode !== "setup" || calls.length !== 1 || call?.name !== "propose_profile"
      || typeof call.call_id !== "string" || typeof call.arguments !== "string") throw new Error("Unexpected Bot tool request");
    const profile = ProfileSchema.parse(JSON.parse(call.arguments));
    const continuation = await responses(fetcher, apiKey, {
      ...request, tools: [], input: [...messages, ...output, {
        type: "function_call_output", call_id: call.call_id,
        output: "Validated. Your standing instructions will be saved together with this reply.",
      }],
    }, signal);
    if (continuation.some((item) => item.type === "function_call")) throw new Error("Unexpected Bot continuation tool");
    return { text: assistantText(continuation), profile };
  };
}
