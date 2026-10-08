import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { z } from "zod/v4";
import type { AgentProviderSummary } from "@matrix-os/contracts";
import type { CodingModelCatalogProjection } from "./provider-catalog.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODELS = 64;
const MAX_OPTIONS = 32;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
// A cold app-server start, one dropped handshake, or a momentary scheduling
// hiccup are all ordinary and should not immediately degrade Codex to
// "unavailable" for a full cache window. One bounded retry after a short
// delay absorbs those without materially slowing a healthy request or
// risking an unbounded/tight retry loop against a genuinely broken CLI.
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;

// Raised when an app-server never reports exit even after SIGKILL. Retrying
// then could overlap a still-live child, so the lookup fails without retrying
// and the source refuses to spawn again until `exited` settles.
class CodexCatalogChildExitTimeoutError extends Error {
  constructor(readonly exited: Promise<void>) {
    super("Codex model catalog process did not exit");
    this.name = "CodexCatalogChildExitTimeoutError";
  }
}
// A failed lookup is cached only briefly. Long enough that repeated polling
// (e.g. an open Chat tab) cannot retry-storm a down or mid-install Codex
// with a fresh spawn+retry sequence on every request; short enough that a
// login or install finishing mid-outage is reflected on the next request
// shortly after, without needing a dedicated invalidation signal.
const DEFAULT_FAILURE_CACHE_TTL_MS = 10_000;

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
  environment?: Record<string, string>;
  timeoutMs: number;
  terminateGraceMs: number;
  spawnProcess: SpawnProcess;
}): Promise<unknown> {
  const child = input.spawnProcess(input.executable, ["app-server", "--stdio"], {
    cwd: input.cwd,
    env: { ...process.env, ...input.environment },
    stdio: "pipe",
  });
  child.stderr.resume();
  // Registered before any other listener so a child that outlives the bounded
  // termination wait is still observed when it finally exits.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("close", () => resolve());
  });
  return await new Promise((resolve, reject) => {
    let buffer = "";
    let totalBytes = 0;
    let settled = false;
    let requestedOutcome: { error?: Error; value?: unknown } | null = null;
    let terminateTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => requestFinish(new Error("Codex model catalog timed out")), input.timeoutMs);
    timeout.unref();

    const settleAfterExit = (forcedOutcome?: { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminateTimer) clearTimeout(terminateTimer);
      const outcome: { error?: Error; value?: unknown } = forcedOutcome
        ?? requestedOutcome
        ?? { error: new Error("Codex model catalog stopped") };
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.value);
    };

    const requestFinish = (error?: Error, value?: unknown) => {
      if (settled || requestedOutcome) return;
      requestedOutcome = { ...(error ? { error } : {}), ...(error ? {} : { value }) };
      clearTimeout(timeout);

      // A retry must never overlap the child from the previous attempt. Ask
      // the app-server to terminate, escalate if it ignores SIGTERM, and only
      // settle this attempt after the OS reports the child has actually
      // closed. fetchCodexModelsWithRetry cannot start its next attempt until
      // this promise settles.
      child.kill("SIGTERM");
      terminateTimer = setTimeout(() => {
        child.kill("SIGKILL");
        // Bound the wait even if the OS never reports exit, so the shared
        // pending lookup cannot hang every later catalog request.
        terminateTimer = setTimeout(() => {
          settleAfterExit({ error: new CodexCatalogChildExitTimeoutError(exited) });
        }, input.terminateGraceMs);
        terminateTimer.unref();
      }, input.terminateGraceMs);
      terminateTimer.unref();
    };
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.once("error", () => requestFinish(new Error("Codex model catalog unavailable")));
    // Once termination was requested, "exit" covers a child whose stdio is
    // still held open by a descendant, where "close" alone could leave this
    // attempt unsettled. Before that, wait for "close" so buffered stdout is
    // still read.
    child.once("exit", () => {
      if (requestedOutcome) settleAfterExit();
    });
    child.once("close", () => settleAfterExit());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      totalBytes += Buffer.byteLength(chunk, "utf8");
      if (totalBytes > MAX_RESPONSE_BYTES) {
        requestFinish(new Error("Codex model catalog exceeded its response limit"));
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
          requestFinish(undefined, message.result);
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function fetchCodexModelsWithRetry(input: {
  executable: string;
  cwd: string;
  environment?: Record<string, string>;
  timeoutMs: number;
  terminateGraceMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  spawnProcess: SpawnProcess;
}): Promise<CodingModelCatalogProjection> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      const raw = await readCodexModels({
        executable: input.executable,
        cwd: input.cwd,
        environment: input.environment,
        timeoutMs: input.timeoutMs,
        terminateGraceMs: input.terminateGraceMs,
        spawnProcess: input.spawnProcess,
      });
      return normalizeCodexModelCatalog(raw);
    } catch (error) {
      if (error instanceof CodexCatalogChildExitTimeoutError) throw error;
      lastError = error;
      // Sequential and bounded: the next attempt only starts once the
      // previous attempt's process has already been terminated inside
      // readCodexModels, so at most one app-server child is ever alive at a
      // time and the total added delay is capped by maxAttempts.
      if (attempt < input.maxAttempts) await wait(input.retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Codex model catalog unavailable");
}

export function createCodexModelCatalogSource(options: {
  executable: string;
  cwd: string;
  environment?: Record<string, string>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  failureCacheTtlMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  terminateGraceMs?: number;
  spawnProcess?: SpawnProcess;
}) {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const cacheTtlMs = Math.max(1, Math.min(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 5 * 60_000));
  const failureCacheTtlMs = Math.max(
    1,
    Math.min(options.failureCacheTtlMs ?? DEFAULT_FAILURE_CACHE_TTL_MS, cacheTtlMs),
  );
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 3));
  const retryDelayMs = Math.max(0, Math.min(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, 2_000));
  const terminateGraceMs = Math.max(
    1,
    Math.min(options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS, 5_000),
  );
  const spawnProcess = options.spawnProcess ?? (nodeSpawn as SpawnProcess);
  let cached: { expiresAt: number; value: CodingModelCatalogProjection } | null = null;
  let failedUntil = 0;
  let unconfirmedChildExit: Promise<void> | null = null;
  let pending: Promise<CodingModelCatalogProjection> | null = null;

  return async (provider: AgentProviderSummary): Promise<CodingModelCatalogProjection | null> => {
    if (provider.kind !== "codex" && provider.id !== "codex") return null;
    // Do not launch an app-server (or return a previously ready catalog) after
    // the canonical provider inventory reports that this connection is unavailable.
    if (provider.availability !== "available") return null;
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (!pending && (failedUntil > now || unconfirmedChildExit)) {
      throw new Error("Codex model catalog unavailable");
    }
    if (!pending) {
      pending = fetchCodexModelsWithRetry({
        executable: options.executable,
        cwd: options.cwd,
        environment: options.environment,
        timeoutMs,
        terminateGraceMs,
        maxAttempts,
        retryDelayMs,
        spawnProcess,
      }).then((value) => {
        cached = { expiresAt: Date.now() + cacheTtlMs, value };
        failedUntil = 0;
        return value;
      }).catch((error: unknown) => {
        // Cache the failure only briefly (see DEFAULT_FAILURE_CACHE_TTL_MS)
        // so repeated polling while Codex is down or mid-install cannot
        // retry-storm it with a fresh spawn+retry sequence on every request.
        failedUntil = Date.now() + failureCacheTtlMs;
        if (error instanceof CodexCatalogChildExitTimeoutError) {
          // Never overlap an app-server whose termination is unconfirmed.
          const exited = error.exited;
          unconfirmedChildExit = exited;
          void exited.then(() => {
            if (unconfirmedChildExit === exited) unconfirmedChildExit = null;
          });
        }
        throw error;
      }).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
