import { describe, expect, it } from "vitest";
import { FUNDED_GLM_FLASH } from "../../packages/proxy/src/funded-relay-model.js";
import { serializeFundedOpenAiRequest } from "../../packages/proxy/src/funded-relay-openai-request.js";

const base = { model: FUNDED_GLM_FLASH, messages: [{ role: "user", content: "Discover a read-only tool" }] };

describe("managed GLM reasoning contract", () => {
  it.each([true, false, undefined])("defaults omitted reasoning to low (stream=%s)", (stream) => {
    const serialized = serializeFundedOpenAiRequest({ ...base, ...(stream === undefined ? {} : { stream }) });
    expect(serialized.request).toMatchObject({ reasoning_effort: "low", max_tokens: 8192 });
    expect(JSON.parse(serialized.body)).toMatchObject({ reasoning_effort: "low", max_tokens: 8192, store: false });
  });

  it.each(["low", "high", "max"])("preserves deliberate %s reasoning", (reasoning_effort) => {
    const serialized = serializeFundedOpenAiRequest({ ...base, reasoning_effort });
    expect(serialized.request.reasoning_effort).toBe(reasoning_effort);
    expect(JSON.parse(serialized.body).reasoning_effort).toBe(reasoning_effort);
  });

  it.each(["medium", "none", "minimal", "xhigh", "", null, 0, false, {}, ["low"]])("rejects unsupported %j reasoning instead of provider fallback", (reasoning_effort) => {
    expect(() => serializeFundedOpenAiRequest({ ...base, reasoning_effort })).toThrow();
  });

  it.each(["max_tokens", "max_completion_tokens"])("preserves the %s bound and every accepted tool/stream field", (bound) => {
    const input = { ...base, messages: [
      { role: "system", content: "Read-only integration QA" },
      ...base.messages,
      { role: "assistant", content: null, reasoning_content: "Choose inventory", tool_calls: [{
        id: "call_inventory", type: "function", function: { name: "integration_inventory", arguments: '{"service":"gmail"}' },
      }] },
      { role: "tool", tool_call_id: "call_inventory", content: '{"actions":["get_profile"]}' },
    ], [bound]: 512, stream: true, stream_options: { include_usage: false },
      tools: [{ type: "function", function: { name: "integration_inventory", description: "Discover read-only actions",
        parameters: { type: "object", properties: { service: { type: "string" } }, required: ["service"], additionalProperties: false } } }],
      tool_choice: "auto", parallel_tool_calls: false, temperature: 0.2, top_p: 0.9,
    };
    const original = structuredClone(input);
    const serialized = serializeFundedOpenAiRequest(input);
    const { [bound]: outputLimit, ...rest } = input;
    expect(JSON.parse(serialized.body)).toEqual({ ...rest, max_tokens: outputLimit, reasoning_effort: "low",
      stream_options: { include_usage: true }, store: false });
    expect(input).toEqual(original);
  });
});
