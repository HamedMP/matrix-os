#!/usr/bin/env node
import { z } from "zod/v4";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_JSON_BYTES = 1024 * 1024;

const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const UNSAFE_DISPLAY_TEXT = /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
// Keep local contract regexes aligned with packages/contracts for direct Node execution.
const RUNTIME_ID = /^rt_[A-Za-z0-9_-]{1,128}$/;
const THREAD_ID = /^thread_[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^task_[A-Za-z0-9_-]{1,128}$/;
const REVIEW_ID = SAFE_REFERENCE;
const TERMINAL_ID = SAFE_REFERENCE;
const WORKTREE_ID = /^wt_[a-z0-9]{12,40}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_-]{1,128}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const SafeDisplayStringSchema = z.string()
  .min(1)
  .max(120)
  .refine((value) => !looksInternal(value), "Unsafe display string");

const SafeSetupCommandSchema = z.string()
  .min(1)
  .max(280)
  .refine((value) => !UNSAFE_DISPLAY_TEXT.test(value), "Unsafe setup command");

const ReferenceIdSchema = z.string()
  .min(1)
  .max(160)
  .regex(SAFE_REFERENCE)
  .refine((value) => !value.includes(".."), "Reference cannot contain traversal");

const SafeSetupActionSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1).max(80).regex(SAFE_SLUG),
    kind: z.literal("open_settings"),
    label: SafeDisplayStringSchema,
  }).strict(),
  z.object({
    id: z.string().min(1).max(80).regex(SAFE_SLUG),
    kind: z.literal("foreground_terminal"),
    label: SafeDisplayStringSchema,
    command: SafeSetupCommandSchema,
  }).strict(),
]);

const RuntimeTargetSchema = z.object({
  id: z.string().regex(RUNTIME_ID),
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "degraded", "offline", "unknown"]),
  channel: z.string().min(1).max(40).regex(SAFE_SLUG).optional(),
  ownerHandle: z.string().min(1).max(80).regex(SAFE_SLUG).optional(),
}).strict();

const RuntimeCapabilitySchema = z.object({
  id: z.enum([
    "codingAgentsRuntimeSummary",
    "codingAgentsDesktopWorkspace",
    "codingAgentsMobileWorkspace",
    "codingAgentsThreadCreate",
    "codingAgentsApprovals",
    "codingAgentsReview",
    "codingAgentsPreview",
    "codingAgentsFiles",
    "codingAgentsSourceControl",
    "codingAgentsNativeMobileTerminal",
  ]),
  enabled: z.boolean(),
  reason: SafeDisplayStringSchema.optional(),
}).strict();

const AgentProviderSummarySchema = z.object({
  id: z.string().min(1).max(80).regex(SAFE_SLUG),
  displayName: SafeDisplayStringSchema,
  kind: z.enum(["claude", "codex", "opencode", "cursor", "custom"]),
  availability: z.enum(["available", "setup_required", "auth_required", "installing", "unavailable", "unknown"]),
  installStatus: z.enum(["installed", "missing", "installing", "failed", "unknown"]),
  authStatus: z.enum(["authenticated", "missing", "expired", "unknown"]),
  supportedModes: z.array(z.enum(["default", "plan", "review", "full_access"])).min(1).max(8),
  defaultMode: z.enum(["default", "plan", "review", "full_access"]),
  defaultModel: SafeDisplayStringSchema.optional(),
  setupActions: z.array(SafeSetupActionSchema).max(6),
  lastCheckedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.supportedModes.includes(value.defaultMode)) {
    ctx.addIssue({ code: "custom", message: "Default mode must be supported", path: ["defaultMode"] });
  }
});

const AgentThreadSummarySchema = z.object({
  id: z.string().regex(THREAD_ID),
  providerId: z.string().min(1).max(80).regex(SAFE_SLUG),
  title: SafeDisplayStringSchema,
  status: z.enum([
    "queued",
    "starting",
    "running",
    "waiting_for_approval",
    "waiting_for_input",
    "completed",
    "failed",
    "aborted",
    "stale",
    "archived",
  ]),
  attention: z.enum(["none", "approval_required", "input_required", "failed", "completed"]).default("none"),
  projectId: ReferenceIdSchema.optional(),
  taskId: z.string().regex(TASK_ID).optional(),
  terminalSessionId: z.string().regex(TERMINAL_ID).optional(),
  eventCursor: ReferenceIdSchema.optional(),
  createdAt: z.string().regex(ISO_DATETIME),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const TerminalSessionSummarySchema = z.object({
  id: z.string().regex(TERMINAL_ID),
  name: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "idle", "exited", "stale", "unavailable"]),
  attachable: z.boolean(),
  cwdLabel: SafeDisplayStringSchema.optional(),
  createdAt: z.string().regex(ISO_DATETIME),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const ReviewSummarySchema = z.object({
  id: z.string().regex(REVIEW_ID),
  projectId: ReferenceIdSchema,
  worktreeId: z.string().regex(WORKTREE_ID),
  status: z.enum([
    "queued",
    "reviewing",
    "implementing",
    "verifying",
    "converged",
    "stalled",
    "failed",
    "failed_parse",
    "stopped",
    "approved",
  ]),
  pullRequestNumber: z.number().int().min(1).max(10_000_000),
  round: z.number().int().min(0).max(100),
  maxRounds: z.number().int().min(1).max(100),
  reviewer: z.string().min(1).max(80).regex(SAFE_SLUG),
  implementer: z.string().min(1).max(80).regex(SAFE_SLUG),
  findings: z.object({
    total: z.number().int().min(0).max(1_000_000),
    high: z.number().int().min(0).max(1_000_000),
    medium: z.number().int().min(0).max(1_000_000),
    low: z.number().int().min(0).max(1_000_000),
  }).strict().optional(),
  safeStatus: SafeDisplayStringSchema.optional(),
  updatedAt: z.string().regex(ISO_DATETIME),
}).strict();

const ProjectSummarySchema = z.object({
  id: ReferenceIdSchema,
  label: SafeDisplayStringSchema,
  status: z.enum(["available", "missing", "stale", "unknown"]).default("unknown"),
  updatedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict();

const PreviewSessionSummarySchema = z.object({
  id: ReferenceIdSchema,
  projectId: ReferenceIdSchema.optional(),
  label: SafeDisplayStringSchema,
  status: z.enum(["starting", "running", "failed", "stopped", "unknown"]),
  origin: z.string().url().max(2048).optional(),
  updatedAt: z.string().regex(ISO_DATETIME).optional(),
}).strict();

const ActivityEventSummarySchema = z.object({
  id: z.string().regex(EVENT_ID),
  kind: z.enum(["thread", "terminal", "provider", "runtime", "review", "preview"]),
  label: SafeDisplayStringSchema,
  occurredAt: z.string().regex(ISO_DATETIME),
}).strict();

const ThreadListSchema = boundedListSchema(AgentThreadSummarySchema, 50);
const ReviewListSchema = boundedListSchema(ReviewSummarySchema, 50);

const RuntimeSummarySchema = z.object({
  runtime: RuntimeTargetSchema,
  capabilities: z.array(RuntimeCapabilitySchema).max(32),
  providers: z.array(AgentProviderSummarySchema).max(20),
  projects: boundedListSchema(ProjectSummarySchema, 50),
  activeThreads: ThreadListSchema,
  attentionThreads: ThreadListSchema.default({ items: [], hasMore: false, limit: 20 }),
  terminalSessions: boundedListSchema(TerminalSessionSummarySchema, 50),
  previewSessions: boundedListSchema(PreviewSessionSummarySchema, 50).default({ items: [], hasMore: false, limit: 50 }),
  recentActivity: boundedListSchema(ActivityEventSummarySchema, 100),
  limits: z.object({
    maxPromptBytes: z.number().int().min(1).max(256 * 1024),
    maxAttachmentCount: z.number().int().min(0).max(32),
    maxTerminalInputBytes: z.number().int().min(1).max(256 * 1024),
    maxListItems: z.number().int().min(1).max(200),
  }).strict(),
  serverTime: z.string().regex(ISO_DATETIME),
}).strict();

const NotificationPreferencesEnvelopeSchema = z.object({
  preferences: z.object({
    attentionPush: z.object({
      approval: z.boolean(),
      input: z.boolean(),
      failed: z.boolean(),
      completed: z.boolean().default(true),
    }).strict(),
  }).strict(),
}).strict();

export class SmokeFailure extends Error {
  constructor(checkName, safeMessage, options = {}) {
    super(safeMessage, options.cause ? { cause: options.cause } : undefined);
    this.name = "SmokeFailure";
    this.checkName = checkName;
    this.safeMessage = safeMessage;
    this.status = options.status;
  }
}

export function normalizeRuntimeUrl(rawUrl) {
  const input = String(rawUrl ?? "").trim();
  if (!input) {
    throw new Error("runtime URL is required");
  }
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("runtime URL must use http or https");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

export function buildAuthHeaders(token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    throw new Error("runtime token is required");
  }
  return {
    Authorization: `Bearer ${normalized}`,
    Accept: "application/json",
  };
}

export function redactForLog(value) {
  return String(value)
    .replace(/--token(?:=|\s+)[^\s]+/g, "--token [redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/([?&](?:token|auth|authorization|access_token)=)[^&\s]+/gi, "$1[redacted]");
}

export function createSmokeConfig(argv = process.argv.slice(2), env = process.env) {
  const flags = parseArgs(argv);
  const runtimeUrl = normalizeRuntimeUrl(flags.url ?? env.MATRIX_RUNTIME_URL ?? env.MATRIX_CODING_AGENT_SMOKE_URL);
  const token = String(env.MATRIX_RUNTIME_TOKEN ?? env.MATRIX_CODING_AGENT_SMOKE_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("runtime token is required");
  }
  const timeoutMs = flags.timeoutMs ?? env.MATRIX_CODING_AGENT_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
  const parsedTimeout = Number(timeoutMs);
  if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1000 || parsedTimeout > 60_000) {
    throw new Error("timeout must be an integer between 1000 and 60000 milliseconds");
  }

  return {
    runtimeUrl,
    token,
    timeoutMs: parsedTimeout,
    projectId: normalizeOptionalProjectId(flags.projectId ?? env.MATRIX_CODING_AGENT_SMOKE_PROJECT_ID),
    json: Boolean(flags.json),
  };
}

export async function runRuntimeSmoke(options) {
  const runtimeUrl = normalizeRuntimeUrl(options.runtimeUrl instanceof URL ? options.runtimeUrl.toString() : options.runtimeUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = buildAuthHeaders(options.token);
  const projectId = normalizeOptionalProjectId(options.projectId);
  const checks = [];

  const summary = await runCheck({
    name: "runtime summary",
    runtimeUrl,
    path: projectId
      ? `/api/coding-agents/summary?projectId=${encodeURIComponent(projectId)}`
      : "/api/coding-agents/summary",
    headers,
    timeoutMs,
    fetchImpl,
    schema: RuntimeSummarySchema,
    contractName: "Runtime summary",
  });
  checks.push({
    name: "runtime summary",
    status: "passed",
    detail: `${summary.providers.length} providers, ${summary.activeThreads.items.length} active threads, ${summary.terminalSessions.items.length} terminals`,
  });

  const threads = await runCheck({
    name: "thread list",
    runtimeUrl,
    path: "/api/coding-agents/threads",
    headers,
    timeoutMs,
    fetchImpl,
    schema: ThreadListSchema,
    contractName: "Thread list",
  });
  checks.push({
    name: "thread list",
    status: "passed",
    detail: `${threads.items.length} threads`,
  });

  const reviews = await runCheck({
    name: "review list",
    runtimeUrl,
    path: "/api/coding-agents/reviews",
    headers,
    timeoutMs,
    fetchImpl,
    schema: ReviewListSchema,
    contractName: "Review list",
  });
  checks.push({
    name: "review list",
    status: "passed",
    detail: `${reviews.items.length} reviews`,
  });

  await runCheck({
    name: "notification preferences",
    runtimeUrl,
    path: "/api/coding-agents/notification-preferences",
    headers,
    timeoutMs,
    fetchImpl,
    schema: NotificationPreferencesEnvelopeSchema,
    contractName: "Notification preferences",
  });
  checks.push({
    name: "notification preferences",
    status: "passed",
    detail: "owner preferences available",
  });

  return { ok: true, checks };
}

async function runCheck({ name, runtimeUrl, path, headers, timeoutMs, fetchImpl, schema, contractName }) {
  const url = new URL(path.replace(/^\/+/, ""), runtimeUrl);
  const response = await fetchJson({ name, url, headers, timeoutMs, fetchImpl });
  const result = schema.safeParse(response);
  if (!result.success) {
    throw new SmokeFailure(name, `${contractName} response did not match the Matrix coding-agent contract.`, {
      cause: result.error,
    });
  }
  return result.data;
}

async function fetchJson({ name, url, headers, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SmokeFailure(name, `${name} is temporarily unreachable. Check the runtime connection and try again.`, {
      cause: err,
    });
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
      throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
        status: response.status,
      });
    }
  }

  const text = await readBoundedText(response, name);

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new SmokeFailure(name, `${name} returned an invalid response. Check the runtime and try again.`, {
      status: response.status,
      cause: err,
    });
  }

  if (!response.ok) {
    const safeCode = safeErrorCode(body);
    throw new SmokeFailure(
      name,
      safeCode
        ? `${name} failed with ${safeCode}. Resolve the runtime issue and try again.`
        : `${name} failed. Resolve the runtime issue and try again.`,
      { status: response.status },
    );
  }

  return body;
}

function boundedListSchema(itemSchema, maxItems) {
  return z.object({
    items: z.array(itemSchema).max(maxItems),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(maxItems),
  }).strict();
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--url") {
      flags.url = argv[++index];
      continue;
    }
    if (arg === "--token" || arg.startsWith("--token=")) {
      throw new Error("Use MATRIX_RUNTIME_TOKEN or MATRIX_CODING_AGENT_SMOKE_TOKEN instead of --token");
    }
    if (arg === "--project-id") {
      flags.projectId = argv[++index];
      continue;
    }
    if (arg === "--timeout-ms") {
      flags.timeoutMs = argv[++index];
      continue;
    }
    throw new Error("Unknown argument");
  }
  return flags;
}

function normalizeOptionalProjectId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = ReferenceIdSchema.safeParse(String(value).trim());
  if (!result.success) {
    throw new Error("project id is invalid");
  }
  return result.data;
}

async function readBoundedText(response, name) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
        status: response.status,
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BYTES) {
        await reader.cancel("response too large").catch(handleStreamCancelError);
        throw new SmokeFailure(name, `${name} returned too much data. Check runtime limits and try again.`, {
          status: response.status,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (err) {
    if (err instanceof SmokeFailure) throw err;
    throw new SmokeFailure(name, `${name} returned an invalid response. Check the runtime and try again.`, {
      status: response.status,
      cause: err,
    });
  }

  return text;
}

function handleStreamCancelError() {
  if (process.env.MATRIX_CODING_AGENT_SMOKE_DEBUG === "1") {
    console.error("response stream cancel failed");
  }
}

function safeErrorCode(body) {
  const code = body?.error?.code;
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null;
}

function looksInternal(value) {
  return /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+|\/home\/|\/opt\/|postgres|stack trace|at\s+\w+\s+\(|\d{1,3}(?:\.\d{1,3}){3})/i.test(value);
}

function formatText(result) {
  return result.checks.map((check) => `ok ${check.name}: ${check.detail}`).join("\n");
}

async function main() {
  try {
    const config = createSmokeConfig();
    const result = await runRuntimeSmoke(config);
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatText(result));
    }
  } catch (err) {
    if (err instanceof SmokeFailure) {
      console.error(redactForLog(`${err.checkName}: ${err.safeMessage}`));
      process.exitCode = 1;
      return;
    }
    console.error(redactForLog(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
