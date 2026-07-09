#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import {
  AgentThreadSnapshotSchema,
  CodingAgentNotificationPreferencesSchema,
  CreateAgentThreadRequestSchema,
  ReviewSummarySchema,
  RuntimeSummarySchema,
  boundedListSchema,
  type AgentThreadSnapshot,
  type RuntimeSummary,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT = "Matrix coding-agent runtime smoke";
const ReviewSummaryListSchema = boundedListSchema(ReviewSummarySchema, 50);
const NotificationPreferencesResponseSchema = z.object({
  preferences: CodingAgentNotificationPreferencesSchema,
}).strict();

export interface SmokeOptions {
  origin: string;
  token: string;
  runtime?: string;
  timeoutMs?: number;
  createThread?: boolean;
  providerId?: string;
  prompt?: string;
  json?: boolean;
  fetchFn?: typeof fetch;
}

export interface SmokeReport {
  ok: true;
  summary: {
    runtimeStatus: RuntimeSummary["runtime"]["status"];
    capabilityCount: number;
    providerCount: number;
    readyProviderCount: number;
    activeThreadCount: number;
    attentionThreadCount: number;
    terminalSessionCount: number;
    previewSessionCount: number;
    reviewCount: number;
    notificationPreferencesReachable: boolean;
    checkedThreadSnapshot: boolean;
    createdThreadStatus: AgentThreadSnapshot["thread"]["status"] | null;
  };
}

interface RuntimeUrlOptions {
  origin: string;
  path: string;
  runtime?: string;
}

export function buildRuntimeUrl(options: RuntimeUrlOptions): URL {
  const origin = normalizeOrigin(options.origin);
  const url = new URL(options.path, origin);
  if (options.runtime && options.runtime !== "primary") {
    url.searchParams.set("runtime", options.runtime);
  }
  return url;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SmokeOptions & { help?: true } {
  const options: Partial<SmokeOptions> = {
    origin: env.MATRIX_CODING_AGENTS_SMOKE_ORIGIN,
    token: env.MATRIX_CODING_AGENTS_SMOKE_TOKEN,
    runtime: env.MATRIX_CODING_AGENTS_SMOKE_RUNTIME,
    timeoutMs: env.MATRIX_CODING_AGENTS_SMOKE_TIMEOUT_MS
      ? parsePositiveInteger(env.MATRIX_CODING_AGENTS_SMOKE_TIMEOUT_MS, "MATRIX_CODING_AGENTS_SMOKE_TIMEOUT_MS")
      : DEFAULT_TIMEOUT_MS,
    createThread: false,
    prompt: DEFAULT_PROMPT,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...(options as SmokeOptions), help: true };
    if (arg === "--origin") options.origin = readValue();
    else if (arg === "--token") options.token = readValue();
    else if (arg === "--runtime") options.runtime = readValue();
    else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInteger(readValue(), "timeout-ms");
    else if (arg === "--create-thread") options.createThread = true;
    else if (arg === "--provider") options.providerId = readValue();
    else if (arg === "--prompt") options.prompt = readValue();
    else if (arg === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.origin) throw new Error("Missing --origin or MATRIX_CODING_AGENTS_SMOKE_ORIGIN");
  if (!options.token) throw new Error("Missing --token or MATRIX_CODING_AGENTS_SMOKE_TOKEN");
  normalizeOrigin(options.origin);
  return options as SmokeOptions;
}

export async function runCodingAgentRuntimeSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const summary = await requestJson({
    label: "runtime summary",
    schema: RuntimeSummarySchema,
    fetchFn,
    url: buildRuntimeUrl({ origin: options.origin, path: "/api/coding-agents/summary", runtime: options.runtime }),
    token: options.token,
    timeoutMs,
  });

  const notificationPreferences = await requestJson({
    label: "notification preferences",
    schema: NotificationPreferencesResponseSchema,
    fetchFn,
    url: buildRuntimeUrl({
      origin: options.origin,
      path: "/api/coding-agents/notification-preferences",
      runtime: options.runtime,
    }),
    token: options.token,
    timeoutMs,
  });

  const reviews = await requestJson({
    label: "review summaries",
    schema: ReviewSummaryListSchema,
    fetchFn,
    url: buildRuntimeUrl({ origin: options.origin, path: "/api/coding-agents/reviews", runtime: options.runtime }),
    token: options.token,
    timeoutMs,
  });

  let checkedThreadSnapshot = false;
  const firstThreadId = summary.activeThreads.items[0]?.id ?? summary.attentionThreads.items[0]?.id;
  if (firstThreadId) {
    await requestJson({
      label: "thread snapshot",
      schema: AgentThreadSnapshotSchema,
      fetchFn,
      url: buildRuntimeUrl({
        origin: options.origin,
        path: `/api/coding-agents/threads/${encodeURIComponent(firstThreadId)}`,
        runtime: options.runtime,
      }),
      token: options.token,
      timeoutMs,
    });
    checkedThreadSnapshot = true;
  }

  let createdThreadStatus: AgentThreadSnapshot["thread"]["status"] | null = null;
  if (options.createThread) {
    const providerId = options.providerId ?? selectProviderId(summary);
    const createRequest = CreateAgentThreadRequestSchema.parse({
      providerId,
      prompt: options.prompt ?? DEFAULT_PROMPT,
      mode: "default",
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      clientRequestId: buildClientRequestId(),
    });
    const created = await requestJson({
      label: "thread creation",
      schema: AgentThreadSnapshotSchema,
      fetchFn,
      url: buildRuntimeUrl({ origin: options.origin, path: "/api/coding-agents/threads", runtime: options.runtime }),
      token: options.token,
      timeoutMs,
      method: "POST",
      body: createRequest,
    });
    createdThreadStatus = created.thread.status;
  }

  return {
    ok: true,
    summary: {
      runtimeStatus: summary.runtime.status,
      capabilityCount: summary.capabilities.length,
      providerCount: summary.providers.length,
      readyProviderCount: summary.providers.filter(isReadyProvider).length,
      activeThreadCount: summary.activeThreads.items.length,
      attentionThreadCount: summary.attentionThreads.items.length,
      terminalSessionCount: summary.terminalSessions.items.length,
      previewSessionCount: summary.previewSessions.items.length,
      reviewCount: reviews.items.length,
      notificationPreferencesReachable: Boolean(notificationPreferences.preferences),
      checkedThreadSnapshot,
      createdThreadStatus,
    },
  };
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Runtime origin must be a valid HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Runtime origin must be a valid HTTP(S) URL");
  }
  return parsed.origin;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new Error(`${label} must be a positive integer up to 120000`);
  }
  return parsed;
}

function isReadyProvider(provider: RuntimeSummary["providers"][number]): boolean {
  return provider.availability === "available" &&
    provider.installStatus === "installed" &&
    provider.authStatus === "authenticated";
}

function selectProviderId(summary: RuntimeSummary): string {
  const provider = summary.providers.find(isReadyProvider) ?? summary.providers[0];
  if (!provider) throw new Error("thread creation unavailable");
  return provider.id;
}

function buildClientRequestId(): string {
  return `req_smoke_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

async function requestJson<TSchema extends z.ZodType>(options: {
  label: string;
  schema: TSchema;
  fetchFn: typeof fetch;
  url: URL;
  token: string;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<z.infer<TSchema>> {
  let response: Response;
  try {
    response = await options.fetchFn(options.url.toString(), {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new Error(`${options.label} unavailable`);
  }

  if (!response.ok) {
    throw new Error(`${options.label} unavailable`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${options.label} unavailable`);
  }

  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${options.label} unavailable`);
  }
  return parsed.data;
}

function printHelp(): void {
  console.log(`Usage: pnpm exec tsx scripts/coding-agent-runtime-smoke.ts --origin <url> --token <token> [options]

Options:
  --runtime <slot>       Runtime slot query value when validating a non-primary runtime.
  --timeout-ms <ms>      Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
  --create-thread        Also create one smoke thread. Read-only by default.
  --provider <id>        Provider id for --create-thread. Defaults to first ready provider.
  --prompt <text>        Prompt for --create-thread.
  --json                 Print JSON summary.

Environment:
  MATRIX_CODING_AGENTS_SMOKE_ORIGIN
  MATRIX_CODING_AGENTS_SMOKE_TOKEN
  MATRIX_CODING_AGENTS_SMOKE_RUNTIME
  MATRIX_CODING_AGENTS_SMOKE_TIMEOUT_MS`);
}

function printReport(report: SmokeReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("Coding-agent runtime smoke passed");
  console.log(`runtime status: ${report.summary.runtimeStatus}`);
  console.log(`providers: ${report.summary.readyProviderCount}/${report.summary.providerCount} ready`);
  console.log(`threads: ${report.summary.activeThreadCount} active, ${report.summary.attentionThreadCount} attention`);
  console.log(`terminals: ${report.summary.terminalSessionCount}`);
  console.log(`previews: ${report.summary.previewSessionCount}`);
  console.log(`reviews: ${report.summary.reviewCount}`);
  console.log(`thread snapshot checked: ${report.summary.checkedThreadSnapshot ? "yes" : "no"}`);
  if (report.summary.createdThreadStatus) {
    console.log(`created thread status: ${report.summary.createdThreadStatus}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runCodingAgentRuntimeSmoke(options);
  printReport(report, Boolean(options.json));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "coding-agent runtime smoke failed");
    process.exitCode = 1;
  });
}
