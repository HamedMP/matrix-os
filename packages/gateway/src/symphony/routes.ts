import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { requestHasBody } from "../http-body.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import { isAuthorizedSymphonyOperator, isSymphonyOwner } from "./auth.js";
import {
  EmptyBodySchema,
  genericSymphonyError,
  LinearCredentialSchema,
  PreviewQuerySchema,
  RunActionSchema,
  RunsQuerySchema,
  SaveSymphonyConfigSchema,
  SYMPHONY_BODY_LIMIT,
  SYMPHONY_EMPTY_BODY_LIMIT,
  type SymphonyRun,
  type MatrixProjectOption,
} from "./contracts.js";
import type { SymphonyCredentialStore } from "./credential-store.js";
import type { LinearSource } from "./linear-source.js";
import type { MatrixSymphonyOrchestrator } from "./orchestrator.js";
import type { SymphonyRepository } from "./repository.js";
import type { SymphonyStatusHub } from "./status-hub.js";

const SSE_HEARTBEAT_MS = 60_000;
const OwnerScopeQuerySchema = z.object({
  ownerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_@:.=-]+$/).optional(),
}).passthrough();

export interface MatrixSymphonyRouteDeps {
  repository: SymphonyRepository;
  credentialStore: SymphonyCredentialStore;
  linearSource: LinearSource;
  orchestrator: MatrixSymphonyOrchestrator;
  statusHub?: SymphonyStatusHub;
  listMatrixProjects?: (ownerId: string) => Promise<MatrixProjectOption[]>;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

function counts(runs: SymphonyRun[]) {
  return {
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    needsAttention: runs.filter((run) => ["retrying", "blocked", "failed"].includes(run.status)).length,
    handoff: runs.filter((run) => ["handoff", "completed"].includes(run.status)).length,
  };
}

function activeAgents(runs: SymphonyRun[]) {
  const activeStatuses = new Set<SymphonyRun["status"]>(["queued", "running", "retrying", "blocked", "handoff", "completed"]);
  const onboardingAgents = new Set<SymphonyRun["agent"]>(["codex", "claude"]);
  return Array.from(new Set(runs
    .filter((run) => activeStatuses.has(run.status))
    .filter((run) => onboardingAgents.has(run.agent))
    .map((run) => run.agent)));
}

function handoffRelevantRuns(runs: SymphonyRun[]) {
  const activeStatuses = new Set<SymphonyRun["status"]>(["queued", "running", "retrying", "blocked", "handoff"]);
  const activeRuns = runs.filter((run) => activeStatuses.has(run.status));
  return activeRuns.length > 0 ? activeRuns : runs.slice(0, 1);
}

function handoffSummary(runs: SymphonyRun[]) {
  const relevantRuns = handoffRelevantRuns(runs);
  const readyCount = relevantRuns.filter((run) => run.status === "handoff" || run.status === "completed").length;
  const needsInputCount = relevantRuns.filter((run) => run.status === "blocked").length;
  const failedCount = relevantRuns.filter((run) => run.status === "failed" || run.status === "stopped").length;
  const runningCount = relevantRuns.filter((run) => run.status === "queued" || run.status === "running" || run.status === "retrying").length;
  if (needsInputCount > 0) {
    return {
      status: "needs_input" as const,
      readyCount,
      needsInputCount,
      failedCount,
      runningCount,
      nextAction: "Open the blocked run and provide input",
    };
  }
  if (readyCount > 0) {
    return {
      status: "ready" as const,
      readyCount,
      needsInputCount,
      failedCount,
      runningCount,
      nextAction: "Review the latest Symphony handoff",
    };
  }
  if (runningCount > 0) {
    return {
      status: "running" as const,
      readyCount,
      needsInputCount,
      failedCount,
      runningCount,
      nextAction: "Monitor the active Symphony run",
    };
  }
  if (failedCount > 0) {
    return {
      status: "failed" as const,
      readyCount,
      needsInputCount,
      failedCount,
      runningCount,
      nextAction: "Review the failure summary and retry when ready",
    };
  }
  return {
    status: "idle" as const,
    readyCount,
    needsInputCount,
    failedCount,
    runningCount,
    nextAction: "Start a coding task",
  };
}

function publicRun(run: SymphonyRun): Omit<SymphonyRun, "worktreePath"> {
  const { worktreePath: _worktreePath, ...safeRun } = run;
  return safeRun;
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<
  { ok: true; value: T } | { ok: false; response: Response }
> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return { ok: false, response: c.json(genericSymphonyError("payload_too_large", "Request body is too large"), status(413)) };
      }
      if (!(err instanceof SyntaxError)) {
        console.error("[symphony] Failed to parse request body:", err);
      }
      return { ok: false, response: c.json(genericSymphonyError("invalid_json", "Request body must be valid JSON"), status(400)) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: c.json(genericSymphonyError("invalid_request", "Request body is invalid"), status(400)) };
  }
  return { ok: true, value: parsed.data };
}

async function withPrincipal(c: Context, deps: MatrixSymphonyRouteDeps, fn: (principal: RequestPrincipal) => Promise<Response>): Promise<Response> {
  try {
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    return await fn(principal);
  } catch (err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Symphony request failed");
    if (mapped.log) console.error("[symphony] Principal resolution failed:", err);
    return c.json(genericSymphonyError("unauthorized", mapped.body.error), status(mapped.status));
  }
}

function unauthorized(c: Context) {
  return c.json(genericSymphonyError("unauthorized", "Unauthorized"), status(401));
}

function queryWithoutOwnerScope(c: Context): Record<string, string> {
  const { ownerId: _ownerId, ...rest } = c.req.query();
  return rest;
}

async function publishSimpleOperatorEvent(
  deps: MatrixSymphonyRouteDeps,
  ownerId: string,
  input: { installationId: string; type: string; message: string; actorId: string },
): Promise<void> {
  await deps.statusHub?.publishOperatorEvent(ownerId, {
    id: `evt_${randomUUID()}`,
    installationId: input.installationId,
    type: input.type,
    message: input.message,
    severity: "info",
    actorId: input.actorId,
    createdAt: new Date().toISOString(),
  });
}

async function requireOperator(c: Context, deps: MatrixSymphonyRouteDeps, principal: RequestPrincipal) {
  const ownerScope = OwnerScopeQuerySchema.safeParse(c.req.query());
  if (!ownerScope.success) {
    return { ok: false as const, response: c.json(genericSymphonyError("invalid_request", "Request query is invalid"), status(400)) };
  }
  const ownerId = ownerScope.data.ownerId ?? await deps.repository.resolveOwnerIdForOperator(principal.userId) ?? principal.userId;
  if (!ownerId) return { ok: false as const, response: unauthorized(c) };
  const snapshot = await deps.repository.getSnapshot(ownerId);
  if (ownerScope.data.ownerId && ownerScope.data.ownerId !== principal.userId && !snapshot.installation) {
    return { ok: false as const, response: unauthorized(c) };
  }
  if (!isAuthorizedSymphonyOperator(principal, snapshot.installation)) return { ok: false as const, response: unauthorized(c) };
  return { ok: true as const, ownerId, snapshot };
}

export function createMatrixSymphonyRoutes(deps: MatrixSymphonyRouteDeps) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: SYMPHONY_BODY_LIMIT });
  const emptyLimited = bodyLimit({ maxSize: SYMPHONY_EMPTY_BODY_LIMIT });

  app.get("/status", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const snapshot = auth.snapshot;
    return c.json({
      running: Boolean(snapshot.installation?.enabled),
      installationId: snapshot.installation?.id ?? null,
      credentialConfigured: Boolean(snapshot.installation?.credentialConfigured),
      pollIntervalMs: snapshot.installation?.pollIntervalMs ?? null,
      maxConcurrentAgents: snapshot.installation?.maxConcurrentAgents ?? null,
      counts: counts(snapshot.runs),
      activeAgents: activeAgents(snapshot.runs),
      handoff: handoffSummary(snapshot.runs),
      lastPollAt: snapshot.lastPollAt,
    });
  }));

  app.get("/config", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    return c.json({ installation: auth.snapshot.installation, rule: auth.snapshot.rule });
  }));

  app.get("/setup-options", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    let matrixProjects: MatrixProjectOption[] = [];
    try {
      matrixProjects = deps.listMatrixProjects ? await deps.listMatrixProjects(auth.ownerId) : [];
    } catch (err: unknown) {
      console.warn("[symphony] Matrix project setup discovery failed:", err instanceof Error ? err.message : String(err));
    }
    const credential = await deps.credentialStore.readLinearCredential(auth.ownerId);
    if (!credential) {
      return c.json({
        credentialConfigured: false,
        matrixProjects,
        linear: { teams: [], projects: [], users: [] },
      });
    }
    if (!deps.linearSource.discoverSetupOptions) {
      return c.json({ credentialConfigured: true, matrixProjects, linear: { teams: [], projects: [], users: [] } });
    }
    try {
      const linear = await deps.linearSource.discoverSetupOptions(credential);
      return c.json({ credentialConfigured: true, matrixProjects, linear });
    } catch (err: unknown) {
      console.warn("[symphony] Linear setup discovery failed:", err instanceof Error ? err.message : String(err));
      return c.json(genericSymphonyError("linear_setup_failed", "Linear setup options could not be loaded"), status(502));
    }
  }));

  app.post("/config", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const snapshot = await deps.repository.getSnapshot(principal.userId);
    if (!isSymphonyOwner(principal, snapshot.installation)) return unauthorized(c);
    const parsed = await parseJson(c, SaveSymphonyConfigSchema);
    if (!parsed.ok) return parsed.response;
    const credentialConfigured = await deps.credentialStore.hasLinearCredential(principal.userId);
    const saved = await deps.repository.saveConfig(principal.userId, parsed.value, principal.userId, credentialConfigured);
    await publishSimpleOperatorEvent(deps, principal.userId, {
      installationId: saved.installation.id,
      type: "symphony.config.updated",
      message: "Symphony configuration updated",
      actorId: principal.userId,
    });
    return c.json({ installation: saved.installation, rule: saved.rule });
  }));

  app.post("/credentials/linear", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const snapshot = await deps.repository.getSnapshot(principal.userId);
    if (!isSymphonyOwner(principal, snapshot.installation)) return unauthorized(c);
    const parsed = await parseJson(c, LinearCredentialSchema);
    if (!parsed.ok) return parsed.response;
    try {
      await deps.credentialStore.writeLinearCredential(principal.userId, parsed.value.secret);
      await deps.repository.setCredentialConfigured(principal.userId, true, principal.userId);
      await publishSimpleOperatorEvent(deps, principal.userId, {
        installationId: snapshot.installation?.id ?? `sym_${principal.userId}`,
        type: "symphony.credential.updated",
        message: "Linear credential updated",
        actorId: principal.userId,
      });
      return c.json({ credentialConfigured: true, accountLabel: "Linear" });
    } catch (err: unknown) {
      console.error("[symphony] Linear credential write failed:", err);
      return c.json(genericSymphonyError("credential_update_failed", "Linear credential could not be saved"), status(500));
    }
  }));

  app.delete("/credentials/linear", emptyLimited, (c) => withPrincipal(c, deps, async (principal) => {
    const snapshot = await deps.repository.getSnapshot(principal.userId);
    if (!isSymphonyOwner(principal, snapshot.installation)) return unauthorized(c);
    const parsed = await parseJson(c, EmptyBodySchema);
    if (!parsed.ok) return parsed.response;
    await deps.credentialStore.deleteLinearCredential(principal.userId);
    const credentialConfigured = await deps.credentialStore.hasLinearCredential(principal.userId);
    await deps.repository.setCredentialConfigured(principal.userId, credentialConfigured, principal.userId);
    await publishSimpleOperatorEvent(deps, principal.userId, {
      installationId: snapshot.installation?.id ?? `sym_${principal.userId}`,
      type: "symphony.credential.deleted",
      message: "Linear credential removed",
      actorId: principal.userId,
    });
    return c.json({ credentialConfigured });
  }));

  app.get("/tickets/preview", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    if (!auth.snapshot.rule) return c.json({ tickets: [], truncated: false });
    const query = PreviewQuerySchema.safeParse(queryWithoutOwnerScope(c));
    if (!query.success) return c.json(genericSymphonyError("invalid_request", "Request query is invalid"), status(400));
    const credential = await deps.credentialStore.readLinearCredential(auth.ownerId);
    if (!credential) return c.json(genericSymphonyError("credential_required", "Linear credential is required"), status(409));
    try {
      return c.json(await deps.linearSource.previewTickets(auth.snapshot.rule, credential, query.data));
    } catch (err: unknown) {
      console.warn("[symphony] Ticket preview failed:", err instanceof Error ? err.message : String(err));
      return c.json(genericSymphonyError("ticket_preview_failed", "Ticket preview failed"), status(502));
    }
  }));

  app.get("/runs", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const query = RunsQuerySchema.safeParse(queryWithoutOwnerScope(c));
    if (!query.success) return c.json(genericSymphonyError("invalid_request", "Request query is invalid"), status(400));
    const runs = await deps.repository.listRuns(auth.ownerId, query.data);
    return c.json({ runs: runs.map(publicRun), nextCursor: null });
  }));

  app.post("/start", emptyLimited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, EmptyBodySchema);
    if (!parsed.ok) return parsed.response;
    const installation = await deps.orchestrator.start(auth.ownerId, principal.userId);
    void deps.orchestrator.poll(auth.ownerId).catch((err: unknown) => {
      console.warn("[symphony] Initial poll after start failed:", err instanceof Error ? err.message : String(err));
    });
    return c.json({ running: installation.enabled, installationId: installation.id });
  }));

  app.post("/stop", emptyLimited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, EmptyBodySchema);
    if (!parsed.ok) return parsed.response;
    const installation = await deps.orchestrator.stop(auth.ownerId, principal.userId);
    return c.json({ running: installation.enabled, installationId: installation.id });
  }));

  app.post("/runs/:runId/actions", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const runId = c.req.param("runId");
    if (!/^run_[A-Za-z0-9_-]{1,128}$/.test(runId)) {
      return c.json(genericSymphonyError("invalid_run", "Run identifier is invalid"), status(400));
    }
    const parsed = await parseJson(c, RunActionSchema);
    if (!parsed.ok) return parsed.response;
    if (parsed.value.type === "open_workspace") {
      const run = await deps.repository.getRun(auth.ownerId, runId);
      if (!run) return c.json(genericSymphonyError("not_found", "Run was not found"), status(404));
      return c.json({ run: publicRun(run), workspacePath: run.worktreeId ? `/workspace/${run.projectSlug}/worktrees/${run.worktreeId}` : null });
    }
    const run = parsed.value.type === "stop"
      ? await deps.orchestrator.stopRun(auth.ownerId, runId, principal.userId)
      : await deps.orchestrator.retryRun(auth.ownerId, runId, principal.userId);
    if (!run) return c.json(genericSymphonyError("not_found", "Run was not found"), status(404));
    return c.json({ run: publicRun(run) });
  }));

  app.get("/events", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    if (!deps.statusHub) return c.text("", status(204));
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const subscriberId = `sub_${randomUUID()}`;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const subscribed = deps.statusHub!.subscribe({
          id: subscriberId,
          ownerId: auth.ownerId,
          send: (event) => {
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          },
          close: () => {
            stopHeartbeat();
            controller.close();
          },
        });
        if (!subscribed.ok) {
          controller.enqueue(encoder.encode("event: symphony.error\ndata: {\"error\":\"subscriber_limit\"}\n\n"));
          controller.close();
          return;
        }
        heartbeat = setInterval(() => {
          if (!deps.statusHub?.touch(subscriberId)) {
            stopHeartbeat();
            return;
          }
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch (err: unknown) {
            console.warn("[symphony] SSE heartbeat failed:", err instanceof Error ? err.message : String(err));
            deps.statusHub?.unsubscribe(subscriberId);
            stopHeartbeat();
          }
        }, SSE_HEARTBEAT_MS);
      },
      cancel() {
        stopHeartbeat();
        deps.statusHub?.unsubscribe(subscriberId);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }));

  return app;
}
