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

describe("brain model credential and provider", () => {
  let home: string;
  let logs: MockInstance[];
  const ownerConfig = async (value: string) => {
    await mkdir(join(home, "system"), { recursive: true });
    await writeFile(join(home, "system/config.json"), value);
  };
  const withOwnerKey = (key = OWNER_KEY) => ownerConfig(JSON.stringify({ kernel: { anthropicApiKey: key } }));
  const resolve = (env: Record<string, string | undefined>) => resolveBrainAnthropicCredential(home, env);
  const fromEnv = { apiKey: SYNTHETIC_KEY, source: "environment" };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "brain-model-config-"));
    logs = (["warn", "error", "log", "info", "debug"] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
  });
  afterEach(async () => {
    for (const log of logs) {
      const printed = inspect(log.mock.calls, { depth: 8 });
      expect(printed).not.toContain(SYNTHETIC_KEY);
      expect(printed).not.toContain(OWNER_KEY);
      log.mockRestore();
    }
    await chmod(join(home, "system/config.json"), 0o600).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rm(home, { recursive: true, force: true });
  });

  it("prefers the owner key to the environment, even with a base URL set", async () => {
    await withOwnerKey();
    const env = { ANTHROPIC_API_KEY: SYNTHETIC_KEY, ANTHROPIC_BASE_URL: "https://relay.example" };
    expect(await resolve(env)).toEqual({ apiKey: OWNER_KEY, source: "owner_key" });
  });

  it("uses a trimmed direct environment key only with no base URL", async () => {
    expect(await resolve({ ANTHROPIC_API_KEY: ` ${SYNTHETIC_KEY}\n` })).toEqual(fromEnv);
    expect(await resolve({ ANTHROPIC_API_KEY: SYNTHETIC_KEY, ANTHROPIC_BASE_URL: " " })).toEqual(fromEnv);
    expect(await resolve({ ANTHROPIC_API_KEY: SYNTHETIC_KEY, ANTHROPIC_BASE_URL: "https://relay.example" }))
      .toBeNull();
    expect(await resolve({})).toBeNull();
  });

  it.each([
    ["a Matrix proxy key", "sk-proxy-synthetic"], ["an OAuth token", "sk-ant-oat01-synthetic"],
    ["a key with spaces", "sk-ant-api03 synthetic"], ["an over-long key", `sk-ant-api03-${"a".repeat(4_090)}`],
  ])("refuses %s", async (_name, key) => {
    expect(await resolve({ ANTHROPIC_API_KEY: key })).toBeNull();
  });

  it("judges an environment key exactly as an owner key, so the two rules cannot drift apart", async () => {
    const keys = [SYNTHETIC_KEY, ` ${SYNTHETIC_KEY}\t`, "sk-proxy-synthetic", "sk-ant-oat01-synthetic", "sk-ant-api",
      "", `sk-ant-api03-${"a".repeat(4_083)}`, `sk-ant-api03-${"a".repeat(4_084)}`, "sk-ant-api03-\u00e9"];
    for (const key of keys) {
      const owner = OwnerAnthropicKeyConfig.safeParse({ kernel: { anthropicApiKey: key } }).success;
      expect([key.length, (await resolve({ ANTHROPIC_API_KEY: key })) !== null]).toEqual([key.length, owner]);
    }
    expect(OwnerAnthropicKeyConfig.safeParse({ kernel: { anthropicApiKey: `sk-ant-api03-${"a".repeat(4_083)}` } }).success)
      .toBe(true);
  });

  it("falls through to the environment on a malformed, invalid or symlinked owner config", async () => {
    const env = { ANTHROPIC_API_KEY: SYNTHETIC_KEY };
    await ownerConfig("{not json");
    expect(await resolve(env)).toEqual(fromEnv);
    await withOwnerKey("sk-proxy-synthetic");
    expect(await resolve(env)).toEqual(fromEnv);
    await rm(join(home, "system/config.json"));
    const elsewhere = join(home, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ kernel: { anthropicApiKey: OWNER_KEY } }));
    await symlink(elsewhere, join(home, "system/config.json"));
    expect(await resolve(env)).toEqual(fromEnv);
  });

  it.skipIf(process.getuid?.() === 0)("rejects when the owner config cannot be read", async () => {
    await withOwnerKey();
    await chmod(join(home, "system/config.json"), 0o000);
    await expect(resolve({ ANTHROPIC_API_KEY: SYNTHETIC_KEY })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("disables the provider on an invalid setting and warns once with the variable name only", async () => {
    const provider = createBrainClaimModelProvider({ homePath: home,
      env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY, MATRIX_BRAIN_MODEL_EFFORT: "turbo-secret-value" } });
    expect(await provider()).toBeNull();
    expect(await provider()).toBeNull();
    const warn = logs[0]!;
    expect(warn.mock.calls).toEqual([["[brain-claims] model extractor disabled by an invalid setting",
      { variable: "MATRIX_BRAIN_MODEL_EFFORT" }]]);
    expect(inspect(warn.mock.calls)).not.toContain("turbo-secret-value");
  });

  it("resolves null without a credential", async () => {
    expect(await createBrainClaimModelProvider({ homePath: home, env: {} })()).toBeNull();
  });

  it("resolves the model, its extractor identity and the run limits", async () => {
    const fake = fakeAnthropic(() => jsonResponse(200, messageBody()));
    const provider = createBrainClaimModelProvider({ homePath: home,
      env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY, MATRIX_BRAIN_MODEL_DOCUMENTS_PER_RUN: "7",
        MATRIX_BRAIN_MODEL_EFFORT: "medium" }, fetch: fake.fetch });
    const resolved = await provider();
    expect(resolved).toMatchObject({ modelId: "claude-opus-5-5", promptVersion: "claims-v2" });
    expect(resolved?.limits).toEqual({ runBudgetMs: 120_000, modelCallTimeoutMs: 60_000, tokensPerRun: 1_000_000,
      documentsPerRun: 7, costMicroUsdPerRun: 500_000, spendMicroUsdPer30d: 5_000_000 });
    expect(inspect(resolved, { depth: 8 })).not.toContain(SYNTHETIC_KEY);
    await resolved?.model.extract(INPUT, new AbortController().signal);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers.get("x-api-key") === SYNTHETIC_KEY).toBe(true);
    expect(fake.requests[0]!.body.output_config.effort).toBe("medium");
  });

  it("builds the default client without a fetch override and makes no call for a skipped body", async () => {
    const fetch = vi.fn(async () => { throw new Error("no network in tests"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const provider = createBrainClaimModelProvider({ homePath: home, env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY } });
      const resolved = await provider();
      expect(await resolved?.model.extract({ ...INPUT, body: "short" }, new AbortController().signal))
        .toMatchObject({ claims: [], outcome: { status: "skipped", code: "body_too_short" } });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the credential on every call", async () => {
    const fake = fakeAnthropic(() => jsonResponse(200, messageBody()));
    const provider = createBrainClaimModelProvider({ homePath: home, env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY },
      fetch: fake.fetch });
    await (await provider())?.model.extract(INPUT, new AbortController().signal);
    await withOwnerKey();
    await (await provider())?.model.extract(INPUT, new AbortController().signal);
    await rm(join(home, "system/config.json"));
    expect(await createBrainClaimModelProvider({ homePath: home, env: {}, fetch: fake.fetch })()).toBeNull();
    const keys = fake.requests.map((request) => request.headers.get("x-api-key"));
    expect(keys[0] === SYNTHETIC_KEY && keys[1] === OWNER_KEY && keys.length === 2).toBe(true);
  });
});
