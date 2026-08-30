import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_KERNEL_MODEL,
  resolveKernelSdkControls,
} from "../../packages/kernel/src/options.js";
import {
  normalizeSdkResult,
  sdkSystemEvent,
} from "../../packages/kernel/src/kernel.js";
import {
  KERNEL_DEFAULTS,
  KERNEL_EFFORTS,
  KERNEL_MODEL_IDS,
  normalizeKernelModel,
  resolveKernelModelOption,
} from "../../packages/gateway/src/kernel-settings.js";
import {
  buildBundledModelCatalog,
  OWNER_ANTHROPIC_MODEL_IDS,
} from "../../packages/gateway/src/ai-providers/model-catalog.js";
import { calculateCost } from "../../packages/proxy/src/cost.js";

describe("production Agent SDK upgrade", () => {
  it("pins the newest package version eligible under the seven-day hold", () => {
    const kernelPackage = JSON.parse(
      readFileSync("packages/kernel/package.json", "utf8"),
    ) as { dependencies: Record<string, string> };
    const browserPackage = JSON.parse(
      readFileSync("packages/mcp-browser/package.json", "utf8"),
    ) as { dependencies: Record<string, string> };
    const integrationsPackage = JSON.parse(
      readFileSync("packages/integrations-mcp/package.json", "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(kernelPackage.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.240");
    expect(browserPackage.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.240");
    expect(integrationsPackage.dependencies["@modelcontextprotocol/sdk"]).toBe("^1.29.0");
  });

  it("uses the current first-party Claude catalog without rewriting legacy IDs", () => {
    expect(DEFAULT_KERNEL_MODEL).toBe("claude-opus-5");
    expect(KERNEL_DEFAULTS.model).toBe("claude-opus-5");
    expect(KERNEL_MODEL_IDS).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    expect(KERNEL_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(KERNEL_MODEL_IDS).not.toContain("claude-mythos-5");
    expect(OWNER_ANTHROPIC_MODEL_IDS).toContain("claude-fable-5");
    expect(buildBundledModelCatalog().find((model) => model.id === "claude-fable-5"))
      .toMatchObject({
        status: "current",
        eligibleAccessSourceIds: ["owner_anthropic_key", "owner_anthropic_profile"],
      });
    expect(normalizeKernelModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(resolveKernelModelOption("claude-sonnet-4-5")).toMatchObject({
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      tier: "Legacy",
    });
    const homeConfig = JSON.parse(readFileSync("home/system/config.json", "utf8")) as {
      kernel: { model: string };
    };
    expect(homeConfig.kernel.model).toBe("claude-opus-5");
  });

  it("calculates costs for every current Claude model", () => {
    const oneMillion = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    expect(calculateCost({ model: "claude-fable-5", ...oneMillion })).toBe(73.5);
    expect(calculateCost({ model: "claude-opus-5", ...oneMillion })).toBe(36.75);
    expect(calculateCost({ model: "claude-sonnet-5", ...oneMillion })).toBe(14.7);
    expect(calculateCost({ model: "claude-haiku-4-5-20251001", ...oneMillion })).toBe(7.35);
  });

  it("only sends effort and adaptive thinking to models that support them", () => {
    expect(resolveKernelSdkControls("claude-fable-5", "max")).toEqual({
      effort: "max",
      thinking: { type: "adaptive" },
    });
    expect(resolveKernelSdkControls("claude-sonnet-5", "xhigh")).toEqual({
      effort: "xhigh",
      thinking: { type: "adaptive" },
    });
    expect(resolveKernelSdkControls("claude-opus-4-6", "xhigh")).toEqual({
      effort: "high",
      thinking: { type: "adaptive" },
    });
    expect(resolveKernelSdkControls("claude-sonnet-4-5", "max")).toEqual({
      effort: "max",
      thinking: { type: "adaptive" },
    });
    expect(resolveKernelSdkControls("claude-haiku-4-5", "max")).toEqual({});
    expect(resolveKernelSdkControls("owner-custom-model", "high")).toEqual({});
  });

  it("verifies Fable controls against the production-pinned SDK declaration", () => {
    const require = createRequire(import.meta.url);
    const sdkDirectory = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const sdkPackage = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8")) as {
      version: string;
      claudeCodeVersion: string;
    };
    const sdkTypes = readFileSync(join(sdkDirectory, "sdk.d.ts"), "utf8");

    expect(sdkPackage).toMatchObject({ version: "0.3.240", claudeCodeVersion: "2.1.240" });
    expect(sdkTypes).toContain("Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'");
    expect(sdkTypes).toMatch(/`'max'` — Maximum effort \(Fable 5,/);
    expect(sdkTypes).toContain("thinking?: ThinkingConfig;");
    expect(resolveKernelSdkControls("claude-fable-5", "max")).toEqual({
      effort: "max",
      thinking: { type: "adaptive" },
    });
  });

  it("normalizes cumulative modelUsage across main and subagent calls", () => {
    expect(normalizeSdkResult({
      session_id: "session-1",
      num_turns: 3,
      total_cost_usd: 99,
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 4,
          webSearchRequests: 0,
          costUSD: 0.2,
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          canonicalModel: "claude-sonnet-5",
          provider: "gateway",
        },
        "claude-haiku-4-5": {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
          canonicalModel: "claude-haiku-4-5-20251001",
          provider: "gateway",
        },
      },
    })).toMatchObject({
      sessionId: "session-1",
      cost: 0.21,
      turns: 3,
      tokensIn: 41,
      tokensOut: 8,
      model: "claude-sonnet-5",
      provider: "gateway",
      modelUsage: [
        expect.objectContaining({ model: "claude-sonnet-5", costUsd: 0.2 }),
        expect.objectContaining({ model: "claude-haiku-4-5-20251001", costUsd: 0.01 }),
      ],
    });
  });

  it("maps the SDK no-fallback refusal to a safe structured kernel event", () => {
    expect(sdkSystemEvent({
      type: "system",
      subtype: "model_refusal_no_fallback",
      stop_reason: "refusal",
    })).toEqual({
      type: "refusal",
      reason: "model_refusal_no_fallback",
      stopReason: "refusal",
    });
  });
});
