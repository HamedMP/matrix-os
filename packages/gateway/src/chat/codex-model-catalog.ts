import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { z } from "zod/v4";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import type { CodingModelCatalogProjection } from "./provider-catalog.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 64;
const MAX_OPTIONS = 32;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

const ReferenceIdSchema = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/);
const RawModelSchema = z.object({
  id: ReferenceIdSchema,
  model: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(280).default(""),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: ReferenceIdSchema,
  supportedReasoningEfforts: z.array(z.object({
    reasoningEffort: ReferenceIdSchema,
    description: z.string().trim().max(280),
  }).passthrough()).max(MAX_OPTIONS),
  inputModalities: z.array(z.enum(["text", "image", "audio"])).max(8).default(["text"]),
  serviceTiers: z.array(z.object({
    id: ReferenceIdSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(280),
  }).passthrough()).max(MAX_OPTIONS).default([]),
  defaultServiceTier: ReferenceIdSchema.nullable().default(null),
}).passthrough();
const RawCatalogSchema = z.object({
  data: z.array(RawModelSchema).max(MAX_MODELS),
  nextCursor: z.string().max(512).nullable(),
}).strict();

function labelFor(value: string): string {
  if (value === "xhigh") return "Extra high";
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

export function normalizeCodexModelCatalog(raw: unknown): CodingModelCatalogProjection {
  const catalog = RawCatalogSchema.parse(raw);
  const visible = catalog.data.filter((model) => !model.hidden);
  if (visible.length === 0) throw new Error("Codex model catalog is empty");

  const effortValues = [...new Set(visible.flatMap((model) => (
    model.supportedReasoningEfforts.map((option) => option.reasoningEffort)
  )))].slice(0, MAX_OPTIONS);
  const serviceTiers = new Map<string, string>();
  for (const tier of visible.flatMap((model) => model.serviceTiers)) {
    if (serviceTiers.size >= MAX_OPTIONS) break;
    if (!serviceTiers.has(tier.id)) serviceTiers.set(tier.id, tier.name);
  }
  const defaultModel = visible.find((model) => model.isDefault) ?? visible[0]!;

  return {
    models: visible.map((model) => {
      const supportsVision = model.inputModalities.includes("image");
      return {
        id: model.id,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        capabilities: [
          ...(model.supportedReasoningEfforts.length > 0 ? ["reasoning" as const] : []),
          "tools" as const,
          ...(supportsVision ? ["vision" as const] : []),
        ],
        supportsVision,
        supportsToolUse: true,
      };
    }),
    options: [
      ...(effortValues.length > 0 ? [{
        id: "effort",
        label: "Reasoning",
        kind: "enum" as const,
        values: effortValues.map((value) => ({ value, label: labelFor(value) })),
        defaultValue: effortValues.includes(defaultModel.defaultReasoningEffort)
          ? defaultModel.defaultReasoningEffort
          : effortValues[0],
        placement: "composer" as const,
      }] : []),
      ...(serviceTiers.size > 0 ? [{
        id: "service_tier",
        label: "Service tier",
        kind: "enum" as const,
        values: [...serviceTiers].map(([value, label]) => ({ value, label })),
        defaultValue: defaultModel.defaultServiceTier && serviceTiers.has(defaultModel.defaultServiceTier)
          ? defaultModel.defaultServiceTier
          : serviceTiers.keys().next().value,
        placement: "advanced" as const,
      }] : []),
    ],
    defaultModel: defaultModel.id,
  };
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

async function readCodexModels(input: {
  executable: string;
  cwd: string;
  timeoutMs: number;
  spawnProcess: SpawnProcess;
}): Promise<unknown> {
  const child = input.spawnProcess(input.executable, ["app-server", "--stdio"], {
    cwd: input.cwd,
    env: process.env,
    stdio: "pipe",
  });
  child.stderr.resume();
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Codex model catalog timed out")), input.timeoutMs);
    timeout.unref();

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.once("error", () => finish(new Error("Codex model catalog unavailable")));
    child.once("close", () => finish(new Error("Codex model catalog stopped")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finish(new Error("Codex model catalog exceeded its response limit"));
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: { id?: unknown; result?: unknown };
        try {
          message = JSON.parse(line) as { id?: unknown; result?: unknown };
        } catch (_error) {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { limit: MAX_MODELS, includeHidden: false } });
        } else if (message.id === 2) {
          finish(undefined, message.result);
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "matrix-os", title: "Matrix OS", version: "1" },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export function createCodexModelCatalogSource(options: {
  executable: string;
  cwd: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  spawnProcess?: SpawnProcess;
}) {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const cacheTtlMs = Math.max(1, Math.min(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 5 * 60_000));
  const spawnProcess = options.spawnProcess ?? (nodeSpawn as SpawnProcess);
  let cached: { expiresAt: number; value: CodingModelCatalogProjection } | null = null;
  let pending: Promise<CodingModelCatalogProjection> | null = null;

  return async (provider: AgentProviderSummary): Promise<CodingModelCatalogProjection | null> => {
    if (provider.kind !== "codex" && provider.id !== "codex") return null;
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (!pending) {
      pending = readCodexModels({
        executable: options.executable,
        cwd: options.cwd,
        timeoutMs,
        spawnProcess,
      }).then(normalizeCodexModelCatalog).then((value) => {
        cached = { expiresAt: Date.now() + cacheTtlMs, value };
        return value;
      }).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
