import { execFile as nodeExecFile } from "node:child_process";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import {
  ElixirIssueSchema,
  ElixirRefreshSchema,
  ElixirStopSchema,
  ElixirStateSchema,
  EmptyProxyBodySchema,
  genericProxyError,
  SymphonyIssueIdentifierSchema,
  SymphonyRunIdSchema,
} from "./proxy-contracts.js";

const DEFAULT_UPSTREAM_ORIGIN = "http://127.0.0.1:4766";
const DEFAULT_SERVICE_CONTROL_PATH = "/opt/matrix/bin/matrix-symphony-control";
const DEFAULT_TIMEOUT_MS = 10_000;
const SERVICE_CONTROL_TIMEOUT_MS = 12_000;
const BODY_LIMIT_BYTES = 1024;

const SymphonyServiceActionSchema = z.enum(["status", "start", "stop"]);
const HostSymphonyServiceStatusSchema = z.object({
  available: z.boolean(),
  running: z.boolean(),
  status: z.enum(["running", "starting", "stopping", "stopped", "unavailable"]).optional(),
  canStart: z.boolean(),
  canStop: z.boolean(),
  credentialConfigured: z.boolean().optional(),
  managedBy: z.string().min(1).max(64).optional(),
});

export type SymphonyServiceAction = z.infer<typeof SymphonyServiceActionSchema>;
export type SymphonyServiceStatus = z.infer<typeof HostSymphonyServiceStatusSchema> & {
  status: "running" | "starting" | "stopping" | "stopped" | "unavailable";
};
export type SymphonyServiceControl = (action: SymphonyServiceAction) => Promise<SymphonyServiceStatus>;

export interface ElixirSymphonyProxyDeps {
  upstreamOrigin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  serviceControl?: SymphonyServiceControl;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

function normalizeLoopbackOrigin(rawOrigin = DEFAULT_UPSTREAM_ORIGIN): string {
  const url = new URL(rawOrigin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Symphony upstream origin must be loopback HTTP");
  }
  return url.origin;
}

function upstreamUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

async function withPrincipal(c: Context, deps: ElixirSymphonyProxyDeps, fn: (principal: RequestPrincipal) => Promise<Response>): Promise<Response> {
  try {
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    return await fn(principal);
  } catch (err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Symphony request failed");
    if (mapped.log) console.error("[symphony] Principal resolution failed:", err);
    return c.json(genericProxyError("unauthorized", mapped.body.error), status(mapped.status));
  }
}

async function parseEmptyJson(c: Context): Promise<{ ok: true } | { ok: false; response: Response }> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return { ok: false, response: c.json(genericProxyError("payload_too_large", "Request body is too large"), status(413)) };
      }
      return { ok: false, response: c.json(genericProxyError("invalid_json", "Request body must be valid JSON"), status(400)) };
    }
  }
  const parsed = EmptyProxyBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: c.json(genericProxyError("invalid_request", "Request body is invalid"), status(400)) };
  }
  return { ok: true };
}

async function fetchJson(deps: Required<Pick<ElixirSymphonyProxyDeps, "fetchImpl" | "timeoutMs">>, url: string, init: RequestInit): Promise<
  { ok: true; status: number; body: unknown } | { ok: false; status: number; body: ReturnType<typeof genericProxyError> }
> {
  try {
    const res = await deps.fetchImpl(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
    let body: unknown;
    try {
      body = await res.json();
    } catch (err: unknown) {
      console.warn("[symphony] Elixir response was not JSON:", err instanceof Error ? err.message : String(err));
      return { ok: false, status: 502, body: genericProxyError("invalid_response", "Symphony returned an invalid response") };
    }
    if (!res.ok) {
      if (res.status === 404) {
        return { ok: false, status: 404, body: genericProxyError("not_found", "Symphony resource not found") };
      }
      return { ok: false, status: 503, body: genericProxyError("service_unavailable", "Symphony is unavailable") };
    }
    return { ok: true, status: res.status, body };
  } catch (err: unknown) {
    console.warn("[symphony] Elixir proxy request failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, status: 503, body: genericProxyError("service_unavailable", "Symphony is unavailable") };
  }
}

function unavailableServiceStatus(): SymphonyServiceStatus {
  return {
    available: false,
    running: false,
    status: "unavailable",
    canStart: false,
    canStop: false,
    managedBy: "systemd",
  };
}

function normalizeServiceStatus(body: unknown): SymphonyServiceStatus {
  const parsed = HostSymphonyServiceStatusSchema.parse(body);
  return {
    ...parsed,
    status: parsed.status ?? (parsed.running ? "running" : parsed.available ? "stopped" : "unavailable"),
  };
}

export function createHostSymphonyServiceControl(controlPath = process.env.SYMPHONY_SERVICE_CONTROL_PATH ?? DEFAULT_SERVICE_CONTROL_PATH): SymphonyServiceControl {
  return async (action) => {
    const parsedAction = SymphonyServiceActionSchema.parse(action);
    const output = await new Promise<string>((resolve, reject) => {
      nodeExecFile(controlPath, [parsedAction], {
        timeout: SERVICE_CONTROL_TIMEOUT_MS,
        maxBuffer: 8 * 1024,
      }, (err, stdout) => {
        if (err) {
          reject(Object.assign(err, { stdout }));
          return;
        }
        resolve(stdout);
      });
    }).catch((err: unknown) => {
      const stdout = typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string"
        ? err.stdout
        : "";
      if (stdout.trim().length > 0) {
        try {
          return JSON.stringify(normalizeServiceStatus(JSON.parse(stdout) as unknown));
        } catch (parseErr: unknown) {
          console.warn("[symphony] Host service control failure stdout was invalid JSON:", parseErr instanceof Error ? parseErr.message : String(parseErr));
        }
      }
      if (parsedAction === "status") {
        console.warn("[symphony] Host service status failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
      throw err;
    });

    if (output === null) return unavailableServiceStatus();
    try {
      return normalizeServiceStatus(JSON.parse(output) as unknown);
    } catch (err: unknown) {
      console.warn("[symphony] Host service control returned invalid JSON:", err instanceof Error ? err.message : String(err));
      if (parsedAction === "status") return unavailableServiceStatus();
      throw err;
    }
  };
}

async function callServiceControl(c: Context, serviceControl: SymphonyServiceControl, action: SymphonyServiceAction): Promise<Response> {
  try {
    const service = await serviceControl(action);
    return c.json({ service });
  } catch (err: unknown) {
    console.warn("[symphony] Host service control failed:", err instanceof Error ? err.message : String(err));
    return c.json(genericProxyError("service_unavailable", "Symphony service control is unavailable"), status(503));
  }
}

function safeText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 500) : null;
}

function scrubText(value: unknown): string | null {
  const text = safeText(value);
  if (!text) return null;
  return text.replace(/\b[A-Za-z0-9_]*(?:secret|token|key)[A-Za-z0-9_]*\b/gi, "[redacted]");
}

function normalizeLogLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => scrubText(typeof entry === "string" ? entry : JSON.stringify(entry)))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 20);
}

function normalizeLogs(value: unknown) {
  if (!value || typeof value !== "object") return { codexSessionLogs: [] };
  const record = value as Record<string, unknown>;
  return {
    codexSessionLogs: normalizeLogLines(record.codex_session_logs ?? record.codexSessionLogs),
  };
}

function normalizeRecentEvents(value: unknown): Array<{ at: string | null; event: string | null; message: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => {
    if (!entry || typeof entry !== "object") {
      return { at: null, event: "event", message: scrubText(entry) };
    }
    const record = entry as Record<string, unknown>;
    return {
      at: safeText(record.at),
      event: safeText(record.event),
      message: scrubText(record.message),
    };
  });
}

function normalizeRunning(entry: Record<string, unknown>) {
  return {
    issueIdentifier: safeText(entry.issue_identifier),
    issueId: safeText(entry.issue_id),
    status: "running",
    state: safeText(entry.state),
    sessionId: safeText(entry.session_id),
    turnCount: typeof entry.turn_count === "number" ? entry.turn_count : 0,
    latestEvent: scrubText(entry.last_event),
    latestMessage: scrubText(entry.last_message),
    startedAt: safeText(entry.started_at),
    updatedAt: safeText(entry.last_event_at),
    allowedActions: ["refresh", "open_workspace", "stop"],
  };
}

function normalizeRetry(entry: Record<string, unknown>) {
  return {
    issueIdentifier: safeText(entry.issue_identifier),
    issueId: safeText(entry.issue_id),
    status: "needs_attention",
    attempt: typeof entry.attempt === "number" ? entry.attempt : 0,
    dueAt: safeText(entry.due_at),
    latestEvent: "retrying",
    allowedActions: ["refresh", "stop"],
  };
}

function normalizeState(body: unknown) {
  const parsed = ElixirStateSchema.parse(body);
  return {
    service: {
      status: parsed.error ? "degraded" : "ready",
      generatedAt: parsed.generated_at ?? null,
      credentialStatus: parsed.credential_status ?? "unavailable",
    },
    groups: {
      queue: [],
      running: (parsed.running ?? []).map(normalizeRunning),
      needsAttention: (parsed.retrying ?? []).map(normalizeRetry),
      done: [],
    },
  };
}

function normalizeIssue(body: unknown) {
  const parsed = ElixirIssueSchema.parse(body);
  return {
    issueIdentifier: parsed.issue_identifier ?? null,
    issueId: parsed.issue_id ?? null,
    status: parsed.status ?? "unknown",
    sessionId: parsed.running?.session_id ?? null,
    turnCount: parsed.running?.turn_count ?? 0,
    latestEvent: scrubText(parsed.running?.last_event),
    latestMessage: scrubText(parsed.running?.last_message),
    workspacePath: safeText(parsed.workspace?.path) ?? null,
    workpadUrl: null,
    logs: normalizeLogs(parsed.logs),
    recentEvents: normalizeRecentEvents(parsed.recent_events),
    retry: parsed.retry ? { attempt: parsed.retry.attempt ?? 0, dueAt: parsed.retry.due_at ?? null } : null,
    allowedActions: ["refresh", "open_workspace", "stop"],
  };
}

export function createElixirSymphonyProxyRoutes(deps: ElixirSymphonyProxyDeps = {}) {
  const origin = normalizeLoopbackOrigin(deps.upstreamOrigin ?? process.env.SYMPHONY_UPSTREAM_ORIGIN);
  const proxyDeps = {
    fetchImpl: deps.fetchImpl ?? fetch,
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const serviceControl = deps.serviceControl ?? createHostSymphonyServiceControl();
  const app = new Hono();
  const emptyLimited = bodyLimit({ maxSize: BODY_LIMIT_BYTES });

  app.get("/state", (c) => withPrincipal(c, deps, async () => {
    const upstream = await fetchJson(proxyDeps, upstreamUrl(origin, "/api/v1/state"), { method: "GET" });
    if (!upstream.ok) return c.json(upstream.body, status(upstream.status));
    try {
      return c.json(normalizeState(upstream.body));
    } catch (err: unknown) {
      console.warn("[symphony] Failed to normalize Elixir state:", err instanceof Error ? err.message : String(err));
      return c.json(genericProxyError("invalid_response", "Symphony returned an invalid response"), status(502));
    }
  }));

  app.get("/service", (c) => withPrincipal(c, deps, async () => {
    return callServiceControl(c, serviceControl, "status");
  }));

  app.post("/service/start", emptyLimited, (c) => withPrincipal(c, deps, async () => {
    const parsed = await parseEmptyJson(c);
    if (!parsed.ok) return parsed.response;
    return callServiceControl(c, serviceControl, "start");
  }));

  app.post("/service/stop", emptyLimited, (c) => withPrincipal(c, deps, async () => {
    const parsed = await parseEmptyJson(c);
    if (!parsed.ok) return parsed.response;
    return callServiceControl(c, serviceControl, "stop");
  }));

  app.get("/issues/:issueIdentifier", (c) => withPrincipal(c, deps, async () => {
    const issueIdentifier = c.req.param("issueIdentifier");
    const parsed = SymphonyIssueIdentifierSchema.safeParse(issueIdentifier);
    if (!parsed.success) return c.json(genericProxyError("invalid_request", "Issue identifier is invalid"), status(400));
    const upstream = await fetchJson(proxyDeps, upstreamUrl(origin, `/api/v1/issues/${encodeURIComponent(parsed.data)}`), { method: "GET" });
    if (!upstream.ok) return c.json(upstream.body, status(upstream.status));
    try {
      return c.json(normalizeIssue(upstream.body));
    } catch (err: unknown) {
      console.warn("[symphony] Failed to normalize Elixir issue:", err instanceof Error ? err.message : String(err));
      return c.json(genericProxyError("invalid_response", "Symphony returned an invalid response"), status(502));
    }
  }));

  app.post("/refresh", emptyLimited, (c) => withPrincipal(c, deps, async () => {
    const parsed = await parseEmptyJson(c);
    if (!parsed.ok) return parsed.response;
    const upstream = await fetchJson(proxyDeps, upstreamUrl(origin, "/api/v1/refresh"), { method: "POST" });
    if (!upstream.ok) return c.json(upstream.body, status(upstream.status));
    try {
      const body = ElixirRefreshSchema.parse(upstream.body);
      return c.json({ requested: true, requestedAt: body.requested_at ?? null }, status(upstream.status === 202 ? 202 : 200));
    } catch (err: unknown) {
      console.warn("[symphony] Failed to normalize Elixir refresh:", err instanceof Error ? err.message : String(err));
      return c.json(genericProxyError("invalid_response", "Symphony returned an invalid response"), status(502));
    }
  }));

  app.post("/runs/:runId/stop", emptyLimited, (c) => withPrincipal(c, deps, async () => {
    const runId = c.req.param("runId");
    const parsedRunId = SymphonyRunIdSchema.safeParse(runId);
    if (!parsedRunId.success) return c.json(genericProxyError("invalid_request", "Run identifier is invalid"), status(400));
    const parsed = await parseEmptyJson(c);
    if (!parsed.ok) return parsed.response;
    const upstream = await fetchJson(proxyDeps, upstreamUrl(origin, `/api/v1/runs/${encodeURIComponent(parsedRunId.data)}/stop`), { method: "POST" });
    if (!upstream.ok) return c.json(upstream.body, status(upstream.status));
    try {
      const body = ElixirStopSchema.parse(upstream.body);
      return c.json({ stopped: body.stopped ?? true, stoppedAt: body.stopped_at ?? null });
    } catch (err: unknown) {
      console.warn("[symphony] Failed to normalize Elixir stop:", err instanceof Error ? err.message : String(err));
      return c.json(genericProxyError("invalid_response", "Symphony returned an invalid response"), status(502));
    }
  }));

  return app;
}
