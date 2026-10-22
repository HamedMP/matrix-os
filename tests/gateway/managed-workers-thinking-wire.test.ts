import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeContext, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { MANAGED_WORKERS_AI_MODELS } from "@matrix-os/contracts";
import { buildOpenCodeRunConfiguration, preparePiRunEnvironment } from "../../packages/gateway/src/coding-agents/managed-harness-process-config.js";
import { serializeFundedOpenAiRequest } from "../../packages/proxy/src/funded-relay-openai-request.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const credentials = { OPENAI_API_KEY: "synthetic-test-key", OPENAI_BASE_URL: "https://matrix-relay.invalid/v1" };

describe("managed Workers reasoning through the real Pi SDK", () => {
  it.each(MANAGED_WORKERS_AI_MODELS)("only exposes and sends reviewed efforts for $id", async (reviewed) => {
    const homePath = await mkdtemp(join(tmpdir(), "managed-thinking-wire-"));
    try {
      const env = await preparePiRunEnvironment({ homePath, credentials });
      const provider = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, "models.json"), "utf8")).providers.cloudflare;
      const model: Model<"openai-completions"> = {
        ...provider.models.find((entry: { id: string }) => entry.id === reviewed.id),
        api: "openai-completions", provider: "cloudflare", baseUrl: provider.baseUrl,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
      };
      expect(model.reasoning).toBe(true);
      expect(model.compat?.supportsReasoningEffort).toBe(reviewed.reasoningEfforts.length > 0);
      const expected = reviewed.reasoningEfforts.length === 0 ? ["off"]
        : levels.filter(level => reviewed.reasoningEfforts.includes(level === "off" ? "none" : level));
      expect(getSupportedThinkingLevels(model)).toEqual(expected);
      // Also request unsupported/stale UI levels: the SDK must clamp them before
      // serialization, rather than relying on the relay to reject real runs.
      for (const level of levels) {
        let body: unknown;
        await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "READY", timestamp: 0 }] }), {
          apiKey: credentials.OPENAI_API_KEY, reasoning: level === "off" ? undefined : level,
          maxTokens: 16, maxRetries: 0,
          fetch: async (_url, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ error: { message: "synthetic transport stop" } }), {
              status: 400, headers: { "content-type": "application/json" },
            });
          },
        }).result();
        expect(body).toBeDefined();
        expect(() => serializeFundedOpenAiRequest(body)).not.toThrow();
        const wire = body as Record<string, unknown>;
        if (reviewed.reasoningEfforts.length === 0) expect(wire.reasoning_effort).toBeUndefined();
        else if (wire.reasoning_effort !== undefined) expect(reviewed.reasoningEfforts).toContain(wire.reasoning_effort);
        expect(wire[reviewed.outputTokenField]).toBe(16);
      }
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });
});

describe("managed OpenCode reasoning variants", () => {
  it.each(MANAGED_WORKERS_AI_MODELS)("overrides generated variants with the reviewed set for $id", model => {
    const config = JSON.parse(buildOpenCodeRunConfiguration(credentials));
    const entry = config.provider.cloudflare.models[model.id];
    expect(entry.reasoning).toBe(true);
    expect(entry.interleaved).toEqual({ field: "reasoning_content" });
    const variants = entry.variants ?? {};
    const selectable = Object.entries(variants).filter(([, options]) => !(options as { disabled?: boolean }).disabled);
    expect(selectable.map(([name]) => name).sort()).toEqual([...model.reasoningEfforts].sort());
    for (const [, options] of selectable) {
      expect(model.reasoningEfforts).toContain((options as { reasoningEffort: string }).reasoningEffort);
    }
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      if (!model.reasoningEfforts.includes(effort)) expect(variants[effort]).toEqual({ disabled: true });
    }
  });
});
