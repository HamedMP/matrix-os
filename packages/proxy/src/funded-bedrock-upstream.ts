import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamCommandOutput,
  type ConverseStreamOutput,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool,
  type ToolChoice,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockRouteConfig } from "./funded-bedrock-route.js";
import type { FundedOpenAiRequest } from "./funded-relay-openai-request.js";
import {
  FundedUpstreamKind,
  type FundedGenerationUpstream,
  type FundedUpstreamDispatchInput,
  type FundedUpstreamDispatchResult,
} from "./funded-relay-upstream.js";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
interface BedrockRuntimeClientLike {
  send(
    command: ConverseStreamCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseStreamCommandOutput>;
  destroy(): void;
}

type BedrockDocument = null | boolean | number | string | BedrockDocument[] | {
  [key: string]: BedrockDocument;
};

export class BedrockUpstreamError extends Error {
  constructor(readonly kind: "throttled" | "unavailable" | "rejected" | "invalid_response") {
    super("Funded AI upstream request failed");
    this.name = "BedrockUpstreamError";
  }
}

function textParts(content: FundedOpenAiRequest["messages"][number]["content"]): string[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content === "" ? [] : [content];
  return content.map((part) => part.text).filter((text) => text !== "");
}

function toBedrockDocument(value: unknown): BedrockDocument {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toBedrockDocument);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toBedrockDocument(entry)]));
  }
  throw new Error("Bedrock document is invalid");
}

function parseToolInput(value: string): BedrockDocument {
  try {
    return toBedrockDocument(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Tool input is invalid");
    throw error;
  }
}

function bedrockTools(request: FundedOpenAiRequest): Tool[] | undefined {
  if (!request.tools || request.tool_choice === "none") return undefined;
  return request.tools.map((entry) => ({
    toolSpec: {
      name: entry.function.name,
      ...(entry.function.description === undefined ? {} : { description: entry.function.description }),
      inputSchema: { json: toBedrockDocument(entry.function.parameters) },
    },
  }));
}

function bedrockToolChoice(request: FundedOpenAiRequest): ToolChoice | undefined {
  if (request.tool_choice === undefined || request.tool_choice === "auto") return { auto: {} };
  if (request.tool_choice === "required") return { any: {} };
  if (request.tool_choice === "none") return undefined;
  return { tool: { name: request.tool_choice.function.name } };
}

export function translateOpenAiToBedrock(
  request: FundedOpenAiRequest,
  route: BedrockRouteConfig,
): ConverseStreamCommandInput {
  if (request.model !== route.clientModelId || request.max_tokens > route.maxOutputTokens) {
    throw new Error("Unsupported funded AI model");
  }
  if (request.stream !== true) throw new Error("Bedrock funded requests require streaming");
  if (request.frequency_penalty !== undefined || request.presence_penalty !== undefined
    || request.seed !== undefined || request.n !== undefined && request.n !== 1) {
    throw new Error("Unsupported Bedrock request option");
  }
  const system: SystemContentBlock[] = [];
  const messages: Message[] = [];
  let conversationStarted = false;
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      if (conversationStarted) throw new Error("System messages must precede the conversation");
      system.push(...textParts(message.content).map((text) => ({ text })));
      continue;
    }
    conversationStarted = true;
    const content: ContentBlock[] = [];
    if (message.role === "tool") {
      content.push({ toolResult: {
        toolUseId: message.tool_call_id,
        content: textParts(message.content).map((text) => ({ text })),
      } });
      messages.push({ role: "user", content });
      continue;
    }
    content.push(...textParts(message.content).map((text) => ({ text })));
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        content.push({ toolUse: {
          toolUseId: call.id,
          name: call.function.name,
          input: parseToolInput(call.function.arguments),
        } });
      }
    }
    if (content.length === 0) throw new Error("Bedrock messages require content");
    messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  if (messages.length === 0) throw new Error("Bedrock messages require a conversation");
  const tools = bedrockTools(request);
  const stopSequences = request.stop === undefined
    ? undefined
    : typeof request.stop === "string" ? [request.stop] : request.stop;
  return {
    modelId: route.inferenceProfile,
    ...(system.length === 0 ? {} : { system }),
    messages,
    inferenceConfig: {
      maxTokens: request.max_tokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.top_p === undefined ? {} : { topP: request.top_p }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
    },
    ...(tools === undefined ? {} : {
      toolConfig: {
        tools,
        ...(bedrockToolChoice(request) === undefined ? {} : { toolChoice: bedrockToolChoice(request) }),
      },
    }),
  };
}

function classifyBedrockError(error: unknown): BedrockUpstreamError {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (name === "ThrottlingException") return new BedrockUpstreamError("throttled");
  if (name === "ValidationException" || name === "AccessDeniedException") {
    return new BedrockUpstreamError("rejected");
  }
  return new BedrockUpstreamError("unavailable");
}

function finishReason(reason: string | undefined): "stop" | "length" | "tool_calls" {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

function validTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000;
}

function openAiUsage(usage: TokenUsage | undefined): Record<string, unknown> | null {
  if (!usage || !validTokenCount(usage.inputTokens) || !validTokenCount(usage.outputTokens)
    || !validTokenCount(usage.totalTokens)
    || usage.totalTokens !== usage.inputTokens + usage.outputTokens) return null;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  if (!validTokenCount(cacheRead) || !validTokenCount(cacheWrite)) return null;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  for (const detail of usage.cacheDetails ?? []) {
    if (!validTokenCount(detail.inputTokens)) return null;
    if (detail.ttl === "5m") cacheWrite5m += detail.inputTokens;
    else if (detail.ttl === "1h") cacheWrite1h += detail.inputTokens;
    else return null;
  }
  if (cacheWrite5m + cacheWrite1h !== cacheWrite) return null;
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: cacheRead,
      cache_write_5m_tokens: cacheWrite5m,
      cache_write_1h_tokens: cacheWrite1h,
    },
  };
}

interface StreamState {
  readonly responseId: string;
  readonly clientModelId: string;
  readonly created: number;
  readonly toolIndexes: Map<number, number>;
  sawMessageStart: boolean;
  sawMessageStop: boolean;
  sawMetadata: boolean;
}

function eventError(event: ConverseStreamOutput): BedrockUpstreamError | null {
  if (event.throttlingException) return new BedrockUpstreamError("throttled");
  if (event.validationException) return new BedrockUpstreamError("rejected");
  if (event.internalServerException || event.modelStreamErrorException || event.serviceUnavailableException) {
    return new BedrockUpstreamError("unavailable");
  }
  if (event.$unknown) return new BedrockUpstreamError("invalid_response");
  return null;
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function translateEvent(event: ConverseStreamOutput, state: StreamState): string[] {
  const error = eventError(event);
  if (error) throw error;
  const base = {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.clientModelId,
  };
  if (event.messageStart) {
    if (state.sawMessageStart || event.messageStart.role !== "assistant") {
      throw new BedrockUpstreamError("invalid_response");
    }
    state.sawMessageStart = true;
    return [sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })];
  }
  if (!state.sawMessageStart || state.sawMetadata) throw new BedrockUpstreamError("invalid_response");
  if (event.contentBlockStart) {
    const { contentBlockIndex, start } = event.contentBlockStart;
    if (!validTokenCount(contentBlockIndex) || !start?.toolUse?.toolUseId || !start.toolUse.name
      || state.toolIndexes.size >= 256 || state.toolIndexes.has(contentBlockIndex)) {
      throw new BedrockUpstreamError("invalid_response");
    }
    const index = state.toolIndexes.size;
    state.toolIndexes.set(contentBlockIndex, index);
    return [sse({ ...base, choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{
      index,
      id: start.toolUse.toolUseId,
      type: "function",
      function: { name: start.toolUse.name, arguments: "" },
    }] } }] })];
  }
  if (event.contentBlockDelta) {
    const { contentBlockIndex, delta } = event.contentBlockDelta;
    if (!delta || !validTokenCount(contentBlockIndex)) throw new BedrockUpstreamError("invalid_response");
    if (delta.text !== undefined) {
      return [sse({ ...base, choices: [{ index: 0, finish_reason: null, delta: { content: delta.text } }] })];
    }
    if (delta.toolUse?.input !== undefined) {
      const index = state.toolIndexes.get(contentBlockIndex);
      if (index === undefined) throw new BedrockUpstreamError("invalid_response");
      return [sse({ ...base, choices: [{ index: 0, finish_reason: null, delta: {
        tool_calls: [{ index, function: { arguments: delta.toolUse.input } }],
      } }] })];
    }
    if (delta.reasoningContent !== undefined) return [];
    throw new BedrockUpstreamError("invalid_response");
  }
  if (event.contentBlockStop) return [];
  if (event.messageStop) {
    if (state.sawMessageStop) throw new BedrockUpstreamError("invalid_response");
    state.sawMessageStop = true;
    return [sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.messageStop.stopReason) }] })];
  }
  if (event.metadata) {
    if (!state.sawMessageStop || state.sawMetadata) throw new BedrockUpstreamError("invalid_response");
    state.sawMetadata = true;
    const usage = openAiUsage(event.metadata.usage);
    return [
      ...(usage ? [sse({ ...base, choices: [], usage })] : []),
      "data: [DONE]\n\n",
    ];
  }
  throw new BedrockUpstreamError("invalid_response");
}

function responseFromIterator(input: {
  iterator: AsyncIterator<ConverseStreamOutput>;
  first: IteratorResult<ConverseStreamOutput>;
  controller: AbortController;
  requestId: string;
  clientModelId: string;
  now: () => Date;
  maxResponseBytes: number;
}): Response {
  const encoder = new TextEncoder();
  const state: StreamState = {
    responseId: `chatcmpl_${input.requestId}`,
    clientModelId: input.clientModelId,
    created: Math.floor(input.now().getTime() / 1_000),
    toolIndexes: new Map(),
    sawMessageStart: false,
    sawMessageStop: false,
    sawMetadata: false,
  };
  let first: IteratorResult<ConverseStreamOutput> | null = input.first;
  let emittedBytes = 0;
  let closed = false;
  async function stopIterator(): Promise<void> {
    if (closed) return;
    closed = true;
    input.controller.abort(new DOMException("Downstream cancelled", "AbortError"));
    try {
      await input.iterator.return?.();
    } catch (error) {
      console.warn("[proxy] Bedrock stream cancellation failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let emitted = false;
        while (!emitted) {
          const next = first ?? await input.iterator.next();
          first = null;
          if (next.done) {
            if (!state.sawMetadata) throw new BedrockUpstreamError("invalid_response");
            closed = true;
            controller.close();
            return;
          }
          for (const block of translateEvent(next.value, state)) {
            const bytes = encoder.encode(block);
            emittedBytes += bytes.byteLength;
            if (emittedBytes > input.maxResponseBytes) throw new BedrockUpstreamError("invalid_response");
            controller.enqueue(bytes);
            emitted = true;
          }
        }
      } catch (error) {
        await stopIterator();
        controller.error(error instanceof BedrockUpstreamError ? error : classifyBedrockError(error));
      }
    },
    async cancel() {
      await stopIterator();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function createBedrockFundedUpstream(
  route: BedrockRouteConfig,
  options: {
    client?: BedrockRuntimeClientLike;
    now?: () => Date;
    maxResponseBytes?: number;
  } = {},
): FundedGenerationUpstream {
  const client = options.client ?? new BedrockRuntimeClient({ region: route.region });
  const now = options.now ?? (() => new Date());
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return {
    async dispatch(input: FundedUpstreamDispatchInput): Promise<FundedUpstreamDispatchResult> {
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      let output: ConverseStreamCommandOutput;
      try {
        const command = new ConverseStreamCommand(translateOpenAiToBedrock(input.request, route));
        output = await client.send(command, { abortSignal: signal });
      } catch (error) {
        throw classifyBedrockError(error);
      }
      if (!output.stream) throw new BedrockUpstreamError("invalid_response");
      const iterator = output.stream[Symbol.asyncIterator]();
      let first: IteratorResult<ConverseStreamOutput>;
      try {
        first = await iterator.next();
      } catch (error) {
        controller.abort(new DOMException("Bedrock stream failed", "AbortError"));
        throw classifyBedrockError(error);
      }
      if (first.done) throw new BedrockUpstreamError("invalid_response");
      return {
        response: responseFromIterator({
          iterator,
          first,
          controller,
          requestId: input.requestId,
          clientModelId: route.clientModelId,
          now,
          maxResponseBytes,
        }),
        provenance: {
          upstream: FundedUpstreamKind.awsBedrock,
          routeId: route.routeId,
          resolvedModel: route.resolvedModel,
          inferenceProfile: route.inferenceProfile,
          region: route.region,
          pricingVersion: route.pricing.version,
          ...(output.$metadata.requestId ? { providerRequestId: output.$metadata.requestId } : {}),
        },
      };
    },
    close() {
      client.destroy();
    },
  };
}
