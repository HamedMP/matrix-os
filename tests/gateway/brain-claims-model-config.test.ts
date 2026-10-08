/**
 * Company Brain model claims: pricing, configuration from the environment, the Anthropic credential (owner key, then
 * a direct environment key) and the per-request provider. Synthetic keys and a fake fetch only; no network.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { OwnerAnthropicKeyConfig } from "../../packages/gateway/src/ai-providers/owner-key-preflight.js";
import {
  createBrainClaimModelProvider, parseBrainModelConfig, resolveBrainAnthropicCredential,
} from "../../packages/gateway/src/brain/claims/model/config.js";
import {
  BRAIN_MODEL_PRICES, brainModelPrice, brainModelUsage,
} from "../../packages/gateway/src/brain/claims/model/pricing.js";
import {
  BRAIN_MODEL_CONFIG_DEFAULTS, type BrainModelIterationCounts, type BrainModelUsageReport,
} from "../../packages/gateway/src/brain/claims/model/types.js";
import { fakeAnthropic, jsonResponse, messageBody, SYNTHETIC_KEY } from "./helpers/brain-model-fetch.js";

const OWNER_KEY = "sk-ant-api03-owner-synthetic";
const INPUT = {
  title: "t", body: "A decision: the store keeps one row per claim. ".repeat(6), kinds: [], maxClaims: 5,
};
const counts = (overrides: Partial<BrainModelIterationCounts> = {}): BrainModelIterationCounts => ({
  type: "message", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: null,
  cache_creation_input_tokens: null, ...overrides,
});
const report = (overrides: Partial<BrainModelUsageReport> = {}): BrainModelUsageReport => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, iterations: null,
  ...overrides,
});

describe("brain model pricing", () => {
  it("prices Claude Opus 5.5 per the reference rates in tenths of a micro-USD", () => {
    expect(BRAIN_MODEL_PRICES["claude-opus-5-5"]).toEqual({ input: 40, output: 200, cacheRead: 2, cacheWrite: 50 });
    expect(brainModelUsage(report({ input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 1_000 }), "claude-opus-5-5")).toEqual(
      { inputTokens: 4_000, outputTokens: 500, cacheReadTokens: 2_000, cacheWriteTokens: 1_000, costMicroUsd: 19_400 });
  });

  it("prices each iteration at its own model and ignores the top-level counts", () => {
    const iterations = [counts({ model: "claude-opus-5-5", input_tokens: 100 }),
      counts({ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 50 })];
    const usage = brainModelUsage(report({ input_tokens: 9_999, output_tokens: 9_999, iterations }), "claude-opus-5-5");
    expect(usage).toEqual(
      { inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costMicroUsd: 2_150 });
  });

  it("rounds up, prices a null iteration model at the requested model, and falls back to top level", () => {
    expect(brainModelUsage(report({ cache_read_input_tokens: 3 }), "claude-opus-5-5").costMicroUsd).toBe(1);
    expect(brainModelUsage(report({ iterations: [counts({ model: null, output_tokens: 10 })] }), "claude-opus-5-5")
      .costMicroUsd).toBe(200);
    expect(brainModelUsage(report({ output_tokens: 10, iterations: [] }), "claude-opus-5-5").costMicroUsd).toBe(200);
  });

  it("prices an unknown model at the highest rate of each field, never under-counting", () => {
    const highest = { input: 50, output: 250, cacheRead: 5, cacheWrite: 63 };
    expect(brainModelPrice("claude-unknown")).toEqual(highest);
    expect(brainModelPrice("constructor")).toEqual(highest);
    expect(brainModelUsage(report({ input_tokens: 1_000, output_tokens: 100 }), "claude-unknown").costMicroUsd)
      .toBe(7_500);
  });
});

describe("brain model configuration", () => {
  it("uses the defaults when nothing or only blanks are set", () => {
    expect(parseBrainModelConfig({})).toEqual({ ok: true, config: BRAIN_MODEL_CONFIG_DEFAULTS });
    expect(parseBrainModelConfig({ MATRIX_BRAIN_MODEL_ID: " ", MATRIX_BRAIN_MODEL_EFFORT: "",
      MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN: "  " })).toEqual({ ok: true, config: BRAIN_MODEL_CONFIG_DEFAULTS });
    expect(BRAIN_MODEL_CONFIG_DEFAULTS).toEqual({ modelId: "claude-opus-5-5", effort: "low", documentsPerRun: 20,
      costMicroUsdPerRun: 500_000, bodyMaxBytes: 32_768, spendMicroUsdPer30d: 5_000_000 });
  });

  it("accepts every setting within bounds", () => {
    expect(parseBrainModelConfig({ MATRIX_BRAIN_MODEL_ID: "claude-opus-5", MATRIX_BRAIN_MODEL_EFFORT: " high ",
      MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN: "500", MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN: "50000000",
      MATRIX_BRAIN_MODEL_BODY_MAX_BYTES: "1024", MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D: "500000000" }))
      .toEqual({ ok: true, config: { modelId: "claude-opus-5", effort: "high", documentsPerRun: 500,
        costMicroUsdPerRun: 50_000_000, bodyMaxBytes: 1_024, spendMicroUsdPer30d: 500_000_000 } });
  });

  it.each([
    ["MATRIX_BRAIN_MODEL_ID", "gpt-4"], ["MATRIX_BRAIN_MODEL_ID", "claude-opus-5-5-20260901"],
    ["MATRIX_BRAIN_MODEL_EFFORT", "turbo"], ["MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN", "0"],
    ["MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN", "501"], ["MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN", "1.5"],
    ["MATRIX_BRAIN_MODEL_COST_MICROUSD_PER_RUN", "0x10"], ["MATRIX_BRAIN_MODEL_BODY_MAX_BYTES", "-1"],
    ["MATRIX_BRAIN_MODEL_BODY_MAX_BYTES", "65537"], ["MATRIX_BRAIN_MODEL_BODY_MAX_BYTES", "1e4"],
    ["MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D", "0"], ["MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D", "500000001"],
  ])("rejects %s=%s by name", (variable, value) => {
    expect(parseBrainModelConfig({ [variable]: value })).toEqual({ ok: false, variable });
  });

  it("reports the first invalid variable in table order", () => {
    expect(parseBrainModelConfig({ MATRIX_BRAIN_MODEL_BODY_MAX_BYTES: "1", MATRIX_BRAIN_MODEL_EFFORT: "turbo" }))
      .toEqual({ ok: false, variable: "MATRIX_BRAIN_MODEL_EFFORT" });
  });
});
