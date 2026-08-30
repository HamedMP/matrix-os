import { describe, expect, it } from "vitest";
import { priceActualUsageMicrousd } from "../../packages/proxy/src/funded-relay-model.js";
import { createFundedUsageTracker } from "../../packages/proxy/src/funded-relay-usage.js";

const encoder = new TextEncoder();
const options = {
  contentType: "text/event-stream",
  nativeModelId: "claude-sonnet-5",
  canonicalModelId: "anthropic/claude-sonnet-5",
  pricingVersion: "anthropic-2026-08-31-standard",
} as const;

describe("funded relay usage parsing", () => {
  it("uses standard Sonnet 5 rates throughout the full context window", () => {
    expect(priceActualUsageMicrousd({
      canonicalModelId: options.canonicalModelId,
      pricingVersion: options.pricingVersion,
      usage: {
        inputTokens: 200_001,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
    })).toBe(400_102);
  });

  it("prices a complete valid Anthropic SSE stream in integer microusd", () => {
    const tracker = createFundedUsageTracker(options);
    const stream = [
      "event: message_start\n",
      "data: {\"type\":\"message_start\",\"message\":{\"type\":\"message\",\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":100,\"output_tokens\":0,\"cache_read_input_tokens\":10,\"cache_creation_input_tokens\":5,\"cache_creation\":{\"ephemeral_5m_input_tokens\":2,\"ephemeral_1h_input_tokens\":3}}}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
      "event: message_delta\n",
      "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":20}}\n\n",
      "event: message_stop\n",
      "data: {\"type\":\"message_stop\"}\n\n",
    ].join("");
    tracker.push(encoder.encode(stream.slice(0, 117)));
    tracker.push(encoder.encode(stream.slice(117)));
    expect(tracker.complete()).toEqual({ mode: "exact", actualCostMicrousd: 419 });
  });

  it("treats truncated, malformed, duplicate-stop, and model-mismatch streams conservatively", () => {
    for (const stream of [
      "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":1}}}\n\n",
      "data: {not-json}\n\n",
      [
        "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-opus-5\",\"usage\":{\"input_tokens\":1}}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
      ].join(""),
      [
        "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5\",\"usage\":{\"input_tokens\":1}}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1}}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
        "data: {\"type\":\"message_stop\"}\n\n",
      ].join(""),
    ]) {
      const tracker = createFundedUsageTracker(options);
      tracker.push(encoder.encode(stream));
      expect(tracker.complete()).toEqual({ mode: "conservative" });
    }
  });

  it("prices a complete bounded JSON response and rejects missing usage", () => {
    const tracker = createFundedUsageTracker({ ...options, contentType: "application/json" });
    tracker.push(encoder.encode(JSON.stringify({
      type: "message",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_creation: {
          ephemeral_5m_input_tokens: 2,
          ephemeral_1h_input_tokens: 3,
        },
      },
    })));
    expect(tracker.complete()).toEqual({ mode: "exact", actualCostMicrousd: 419 });

    const missing = createFundedUsageTracker({ ...options, contentType: "application/json" });
    missing.push(encoder.encode("{\"type\":\"message\"}"));
    expect(missing.complete()).toEqual({ mode: "conservative" });
  });

  it("fails closed when cache creation usage lacks an exact TTL breakdown", () => {
    for (const usage of [
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 2,
      },
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 2,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 0,
        },
      },
    ]) {
      const tracker = createFundedUsageTracker({ ...options, contentType: "application/json" });
      tracker.push(encoder.encode(JSON.stringify({
        type: "message",
        model: "claude-sonnet-5",
        usage,
      })));
      expect(tracker.complete()).toEqual({ mode: "conservative" });
    }
  });
});
