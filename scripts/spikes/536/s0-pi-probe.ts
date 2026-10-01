/**
 * S0 Pi probe for spec 536 (spike-plan.md, stage S0). Live model spend: never
 * run in CI. Usage:
 *
 *   S0_PROBE_API_KEY=... bun scripts/spikes/536/s0-pi-probe.ts --spend-cap-usd 2
 *
 * Talks to the provider directly because the loopback bridge only exists
 * inside a scope-runtime workload (L5). Evidence records statuses, timings,
 * token counts, and estimated cost only; no prompts, replies, keys, or
 * artifacts. Prices default to Claude Haiku 4.5 list prices in USD per
 * million tokens; override them with S0_PROBE_PRICE_{INPUT,OUTPUT,CACHE_READ,CACHE_WRITE}.
 * Cases stop once the recorded spend reaches the cap.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProvider, type Api, type Model, type Provider, type Usage } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { BotRunCommand, BotSessionSnapshot, BotToolRequest, BotToolResult } from "@matrix-os/contracts";
import { BotBrokerError, type BotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { compactSession, decodeSession } from "../../../packages/bot-runtime/src/session.js";

const spendArg = process.argv.indexOf("--spend-cap-usd");
const spendCap = spendArg > 0 ? Number(process.argv[spendArg + 1]) : Number.NaN;
const apiKey = process.env.S0_PROBE_API_KEY;
const modelId = process.env.S0_PROBE_MODEL ?? "claude-haiku-4-5-20251001";
if (!Number.isFinite(spendCap) || spendCap <= 0 || spendCap > 10) {
  console.error("Refusing to run: pass --spend-cap-usd between 0 and 10, approved for this probe.");
  process.exit(2);
}
if (!apiKey) {
  console.error("Refusing to run: S0_PROBE_API_KEY is required.");
  process.exit(2);
}

function price(name: string, fallback: number): number {
  const value = Number(process.env[`S0_PROBE_PRICE_${name}`] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Refusing to run: S0_PROBE_PRICE_${name} must be a non-negative number.`);
    process.exit(2);
  }
  return value;
}

const model: Model<Api> = {
  id: modelId, name: modelId, api: "anthropic-messages", provider: "s0-probe", baseUrl: "https://api.anthropic.com",
  reasoning: false, input: ["text", "image"],
  cost: { input: price("INPUT", 1), output: price("OUTPUT", 5), cacheRead: price("CACHE_READ", 0.1), cacheWrite: price("CACHE_WRITE", 1.25) },
  contextWindow: 200_000, maxTokens: 2_048,
};
const baseProvider = createProvider<Api>({
  id: "s0-probe", auth: { apiKey: { name: "S0 probe", resolve: async () => ({ auth: { apiKey } }) } },
  models: [model], api: { "anthropic-messages": anthropicMessagesApi() },
});

interface CaseUsage { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
const emptyUsage = (): CaseUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
let caseUsage = emptyUsage();
let spentUsd = 0;
const pendingUsage: Promise<void>[] = [];

function record(usage: Usage) {
  caseUsage.calls += 1;
  caseUsage.inputTokens += usage.input;
  caseUsage.outputTokens += usage.output;
  caseUsage.cacheReadTokens += usage.cacheRead;
  caseUsage.cacheWriteTokens += usage.cacheWrite;
  caseUsage.costUsd += usage.cost.total;
  spentUsd += usage.cost.total;
}

/** Every model call made by the probe, including compaction summaries, is metered here. */
const provider: Provider<Api> = Object.assign(Object.create(baseProvider) as Provider<Api>, {
  streamSimple: ((streamModel, context, options) => {
    const stream = baseProvider.streamSimple(streamModel, context, { ...options, apiKey });
    pendingUsage.push(stream.result().then((reply) => record(reply.usage), (error: unknown) => {
      console.warn("s0 probe call ended without usage:", error instanceof Error ? error.name : "UnknownError");
    }));
    return stream;
  }) as Provider<Api>["streamSimple"],
});

function memoryBroker(options: { refuse?: boolean } = {}) {
  const artifacts = new Map<string, string>();
  let session: BotSessionSnapshot = { revision: 0, messages: [] };
  const broker: BotBrokerClient = {
    loadSession: async () => session,
    saveSession: async (saved) => {
      if (saved.baseRevision !== session.revision) throw new BotBrokerError("stale_generation");
      session = { revision: session.revision + 1, messages: saved.messages };
      return { revision: session.revision };
    },
    tool: async (request: BotToolRequest): Promise<BotToolResult> => {
      if (options.refuse) throw new BotBrokerError("not_granted");
      if (request.capability === "artifact.write") {
        artifacts.set(request.args.relPath, request.args.content);
        return { ok: true, content: [{ type: "text", text: `Saved ${request.args.relPath}` }] };
      }
      if (request.capability === "artifact.read") {
        const content = artifacts.get(request.args.relPath);
        return content === undefined ? { ok: false, code: "unavailable" } : { ok: true, content: [{ type: "text", text: content }] };
      }
      return { ok: false, code: "denied" };
    },
    event: async () => {},
  };
  return { broker, artifacts, session: () => session };
}

const command = (runId: string, text: string, overrides: Partial<BotRunCommand> = {}): BotRunCommand => ({
  version: 1, kind: "bot.run", runId,
  route: { api: "anthropic-messages", modelId, input: ["text", "image"], contextWindow: 200_000, maxOutputTokens: 2_048 },
  systemPrompt: "You are a concise probe bot. Use tools when asked. Never invent file contents.",
  capabilities: ["artifact.write", "artifact.read"], limits: { maxToolActions: 6 },
  turn: { kind: "prompt", text }, ...overrides,
});

async function timed<T>(name: string, fn: () => Promise<T>, check: (value: T) => boolean) {
  if (spentUsd >= spendCap) return { name, passed: false, durationMs: 0, skipped: "spend_cap_reached", usage: emptyUsage() };
  caseUsage = emptyUsage();
  const started = Date.now();
  const settle = async () => {
    await Promise.all(pendingUsage.splice(0));
    return { durationMs: Date.now() - started, usage: caseUsage };
  };
  try {
    const value = await fn();
    return { name, passed: check(value), ...(await settle()), value };
  } catch (error: unknown) {
    return { name, passed: false, ...(await settle()), error: error instanceof Error ? error.name : "UnknownError" };
  }
}

const cases = [];
const toolRun = memoryBroker();
cases.push(await timed("text_tool_call", () => runBotTurn({
  command: command("run_s0_tool", "Write the word ready to notes/probe.md, then read it back."),
  broker: toolRun.broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model },
}), (outcome) => outcome.status === "completed" && toolRun.artifacts.get("notes/probe.md")?.includes("ready") === true));

const redPixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
cases.push(await timed("image_input", () => runBotTurn({
  command: command("run_s0_image", "What single colour is this image? Answer in one word.", {
    capabilities: [], turn: { kind: "prompt", text: "What single colour is this image? Answer in one word.", images: [{ mimeType: "image/png", data: redPixel }] },
  }),
  broker: memoryBroker().broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model },
}), (outcome) => outcome.status === "completed"));

const refused = memoryBroker({ refuse: true });
cases.push(await timed("denied_call_not_executed", () => runBotTurn({
  command: command("run_s0_denied", "Write hello to notes/denied.md."),
  broker: refused.broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model },
}), (outcome) => outcome.status === "completed" && refused.artifacts.size === 0));

const cancel = new AbortController();
setTimeout(() => cancel.abort(), 150);
cases.push(await timed("cancellation", () => runBotTurn({
  command: command("run_s0_cancel", "Count slowly from one to two hundred."),
  broker: memoryBroker().broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model }, signal: cancel.signal,
}), (outcome) => outcome.status === "cancelled" || outcome.status === "uncertain"));

const memory = memoryBroker();
cases.push(await timed("context_reconstruction", async () => {
  await runBotTurn({ command: command("run_s0_mem1", "Remember: the project codename is Juniper. Reply ok.", { capabilities: [] }),
    broker: memory.broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model } });
  return runBotTurn({ command: command("run_s0_mem2", "What is the project codename? One word.", { capabilities: [] }),
    broker: memory.broker, bridgeOrigin: "http://127.0.0.1:1", route: { provider, model } });
}, (outcome) => outcome.status === "completed" && JSON.stringify(memory.session().messages.at(-1)).includes("Juniper")));

cases.push(await timed("compaction", async () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ role: "user" as const, content: `Fact ${index}: item ${index} costs ${index} dollars.`, timestamp: index }));
  return compactSession({
    messages: decodeSession(history), now: Date.now,
    summarize: async (transcript) => {
      const reply = await provider.streamSimple(model, { messages: [{ role: "user", content: `Summarize:\n${transcript}`, timestamp: Date.now() }] } as never, { maxTokens: 512 }).result();
      return reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    },
  });
}, (messages) => messages.length === 5));

const evidence = {
  probe: "s0-pi",
  recordedAt: new Date().toISOString(),
  model: modelId,
  packages: { "pi-agent-core": "0.86.1", "pi-ai": "0.86.1" },
  spendCapUsd: spendCap,
  prices: { currency: "USD", perMillionTokens: model.cost },
  spentUsd: Number(spentUsd.toFixed(6)),
  cases: cases.map((result) => ({
    name: result.name, passed: result.passed, durationMs: result.durationMs,
    usage: { ...result.usage, costUsd: Number(result.usage.costUsd.toFixed(6)) },
    ...("skipped" in result ? { skipped: result.skipped } : {}),
    ...("error" in result && result.error ? { error: result.error } : {}),
    ...("value" in result && result.value && typeof result.value === "object" && "status" in result.value
      ? { status: result.value.status, toolActions: result.value.toolActions } : {}),
  })),
};
const dir = join("specs", "536-conversational-bots", "evidence", "s0");
await mkdir(dir, { recursive: true });
await writeFile(join(dir, `${evidence.recordedAt.replace(/[:.]/g, "-")}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(evidence.cases));
process.exit(cases.every((result) => result.passed) ? 0 : 1);
