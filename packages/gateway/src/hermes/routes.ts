import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { requestHasBody } from "../http-body.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal, type RequestPrincipal } from "../request-principal.js";
import { isAuthorizedHermesOperator, isHermesOwnerOnly } from "./auth.js";
import type { HermesBridge } from "./bridge.js";
import { HermesBridgeError } from "./bridge.js";
import {
  ApprovalDecisionInputSchema,
  ChannelActionInputSchema,
  ChannelIdParamSchema,
  CreateSessionInputSchema,
  EmptyBodySchema,
  GatewayActionInputSchema,
  HERMES_BODY_LIMIT,
  HERMES_EMPTY_BODY_LIMIT,
  MAX_HERMES_CAPABILITIES,
  MAX_HERMES_CHANNELS,
  ApprovalIdParamSchema,
  HermesConfigInputSchema,
  ModelCredentialInputSchema,
  OwnerScopeQuerySchema,
  SendPromptInputSchema,
  SessionIdParamSchema,
  SessionQuerySchema,
  buildStatus,
  defaultHermesInstallation,
  genericHermesError,
  publicSnapshot,
  safeMessage,
  type HermesCapability,
  type HermesInstallation,
  type HermesSession,
  type HermesStreamEvent,
  type MessagingChannel,
  type OperatorEvent,
} from "./contracts.js";
import type { HermesCredentialStore } from "./credential-store.js";
import type { HermesEventHub } from "./event-hub.js";
import type { HermesRepository } from "./repository.js";

export interface HermesRouteDeps {
  repository: HermesRepository;
  credentialStore: HermesCredentialStore;
  bridge: HermesBridge;
  eventHub?: HermesEventHub;
  getPrincipal?: (c: Context) => RequestPrincipal;
}

interface ActionLockEntry {
  token: string;
  expiresAt: number;
}

interface ActionLockOptions {
  maxLocks: number;
  ttlMs: number;
}

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

async function withActionLock<T>(activeActions: Map<string, ActionLockEntry>, key: string, options: ActionLockOptions, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [lockKey, entry] of activeActions) {
    if (entry.expiresAt <= now) activeActions.delete(lockKey);
  }
  if (activeActions.has(key)) throw new HermesBridgeError("conflict");
  if (activeActions.size >= options.maxLocks) throw new HermesBridgeError("unavailable");
  const token = randomUUID();
  activeActions.set(key, { token, expiresAt: now + options.ttlMs });
  try {
    return await fn();
  } finally {
    if (activeActions.get(key)?.token === token) activeActions.delete(key);
  }
}

async function parseJson<T>(c: Context, schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } }): Promise<
  { ok: true; value: T } | { ok: false; response: Response }
> {
  let raw: unknown = {};
  if (requestHasBody(c)) {
    try {
      raw = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return { ok: false, response: c.json(genericHermesError("payload_too_large", "Request body is too large"), status(413)) };
      }
      if (!(err instanceof SyntaxError)) console.error("[hermes] Failed to parse request body:", err);
      return { ok: false, response: c.json(genericHermesError("invalid_json", "Request body must be valid JSON"), status(400)) };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: c.json(genericHermesError("invalid_request", "Request body is invalid"), status(400)) };
  return { ok: true, value: parsed.data };
}

async function withPrincipal(c: Context, deps: HermesRouteDeps, fn: (principal: RequestPrincipal) => Promise<Response>): Promise<Response> {
  try {
    const principal = deps.getPrincipal?.(c) ?? requireRequestPrincipal(c, { requireAuthContextReady: false });
    return await fn(principal);
  } catch (err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Hermes request failed");
    if (mapped.log) console.error("[hermes] Principal resolution failed:", err);
    return c.json(genericHermesError("unauthorized", mapped.body.error), status(mapped.status));
  }
}

function mapError(c: Context, err: unknown): Response {
  if (err instanceof HermesBridgeError) {
    const code = err.code === "invalid_request" ? 400 : err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "timeout" ? 504 : err.code === "unavailable" ? 503 : 502;
    return c.json(genericHermesError(err.code, safeMessage(err.message, "Hermes request failed")), status(code));
  }
  console.error("[hermes] Request failed:", err);
  return c.json(genericHermesError(), status(500));
}

function mergeLiveChannels(storedChannels: MessagingChannel[], liveChannels: MessagingChannel[]): MessagingChannel[] {
  const storedById = new Map(storedChannels.map((channel) => [channel.id, channel]));
  const liveIds = new Set(liveChannels.map((channel) => channel.id));
  const merged = liveChannels.map((live) => {
    const stored = storedById.get(live.id);
    if (!stored) return live;
    const liveHasConfiguredState = live.configured || live.enabled || !["disabled", "disconnected"].includes(live.status);
    if (liveHasConfiguredState) return { ...stored, ...live };
    return { ...live, ...stored, lastCheckedAt: live.lastCheckedAt ?? stored.lastCheckedAt };
  });
  return [...merged, ...storedChannels.filter((channel) => !liveIds.has(channel.id))].slice(0, MAX_HERMES_CHANNELS);
}

function mergeLiveCapabilities(storedCapabilities: HermesCapability[], liveCapabilities: HermesCapability[]): HermesCapability[] {
  const storedById = new Map(storedCapabilities.map((capability) => [capability.id, capability]));
  const liveIds = new Set(liveCapabilities.map((capability) => capability.id));
  const merged = liveCapabilities.map((live) => ({ ...(storedById.get(live.id) ?? {}), ...live }));
  return [...merged, ...storedCapabilities.filter((capability) => !liveIds.has(capability.id))].slice(0, MAX_HERMES_CAPABILITIES);
}

function responseInstallationWithStatusPatch(existing: HermesInstallation, patch: Partial<HermesInstallation>): HermesInstallation {
  const readiness = patch.readiness === "installed" && existing.readiness !== "missing"
    ? existing.readiness
    : patch.readiness ?? existing.readiness;
  return { ...existing, ...patch, readiness };
}

function shouldPersistStatusPatch(existing: HermesInstallation, patch: Partial<HermesInstallation>): boolean {
  if (patch.readiness && !(patch.readiness === "installed" && existing.readiness !== "missing") && patch.readiness !== existing.readiness) return true;
  if (patch.gatewayStatus && patch.gatewayStatus !== existing.gatewayStatus) return true;
  if (patch.version != null && patch.version !== existing.version) return true;
  if (patch.hermesPathLabel !== undefined && patch.hermesPathLabel !== existing.hermesPathLabel) return true;
  return false;
}

async function requireOperator(c: Context, deps: HermesRouteDeps, principal: RequestPrincipal) {
  const ownerScope = OwnerScopeQuerySchema.safeParse(c.req.query());
  if (!ownerScope.success) {
    return { ok: false as const, response: c.json(genericHermesError("invalid_request", "Request query is invalid"), status(400)) };
  }
  const ownerId = ownerScope.data.ownerId ?? await deps.repository.resolveOwnerIdForOperator(principal.userId) ?? principal.userId;
  const snapshot = await deps.repository.getSnapshot(ownerId);
  if (ownerScope.data.ownerId && ownerScope.data.ownerId !== principal.userId && !snapshot.installation) {
    return { ok: false as const, response: c.json(genericHermesError("unauthorized", "Unauthorized"), status(401)) };
  }
  if (!isAuthorizedHermesOperator(principal, snapshot.installation)) {
    return { ok: false as const, response: c.json(genericHermesError("unauthorized", "Unauthorized"), status(401)) };
  }
  return { ok: true as const, ownerId, snapshot };
}

async function requireOwner(c: Context, deps: HermesRouteDeps, principal: RequestPrincipal) {
  const auth = await requireOperator(c, deps, principal);
  if (!auth.ok) return auth;
  if (!isHermesOwnerOnly(principal, auth.snapshot.installation)) {
    return { ok: false as const, response: c.json(genericHermesError("unauthorized", "Unauthorized"), status(401)) };
  }
  return auth;
}

async function appendOperatorEvent(deps: HermesRouteDeps, ownerId: string, input: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
  const event = await deps.repository.appendEvent(ownerId, input);
  await deps.eventHub?.publish(ownerId, {
    type: "operator.event",
    installationId: event.installationId,
    payload: { category: event.category, severity: event.severity, message: event.message, targetId: event.targetId },
  });
  return event;
}

export function createHermesRoutes(deps: HermesRouteDeps) {
  const app = new Hono();
  const limited = bodyLimit({ maxSize: HERMES_BODY_LIMIT });
  const emptyLimited = bodyLimit({ maxSize: HERMES_EMPTY_BODY_LIMIT });
  const activeActions = new Map<string, ActionLockEntry>();
  const actionLockOptions: ActionLockOptions = { maxLocks: 500, ttlMs: 60_000 };

  app.get("/status", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    try {
      const patch = await deps.bridge.getStatus({ ownerId: auth.ownerId, installation: auth.snapshot.installation });
      if (auth.snapshot.installation && shouldPersistStatusPatch(auth.snapshot.installation, patch)) {
        await deps.repository.applyInstallationPatch(auth.ownerId, patch);
        return c.json(buildStatus(await deps.repository.getSnapshot(auth.ownerId)));
      }
      const snapshot = auth.snapshot.installation
        ? { ...auth.snapshot, installation: responseInstallationWithStatusPatch(auth.snapshot.installation, patch) }
        : auth.snapshot;
      return c.json(buildStatus(snapshot));
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/config", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    return c.json(publicSnapshot(auth.snapshot));
  }));

  app.post("/config", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOwner(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, HermesConfigInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await deps.bridge.saveConfig({ ownerId: auth.ownerId, installation: auth.snapshot.installation, config: parsed.value });
      await deps.repository.saveConfig(auth.ownerId, parsed.value, principal.userId, result.patch);
      result.activate();
      await appendOperatorEvent(deps, auth.ownerId, {
        installationId: auth.snapshot.installation?.id ?? defaultHermesInstallation(auth.ownerId).id,
        actorId: principal.userId,
        category: "setup",
        severity: "info",
        message: "Hermes configuration updated",
      });
      return c.json(publicSnapshot(await deps.repository.getSnapshot(auth.ownerId)));
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.post("/credentials/model", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOwner(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, ModelCredentialInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const provider = await withActionLock(activeActions, `${auth.ownerId}:credential:${parsed.value.providerId}`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        const savedProvider = await deps.bridge.saveModelCredential({ ownerId: auth.ownerId, installation: currentSnapshot.installation, credential: parsed.value });
        await deps.credentialStore.writeModelCredential(auth.ownerId, parsed.value.providerId, parsed.value.secret);
        return await deps.repository.setModelCredentialConfigured(auth.ownerId, savedProvider, principal.userId);
      });
      await appendOperatorEvent(deps, auth.ownerId, {
        installationId: auth.snapshot.installation?.id ?? defaultHermesInstallation(auth.ownerId).id,
        actorId: principal.userId,
        category: "credential",
        severity: "info",
        message: "Model credential updated",
        targetId: parsed.value.providerId,
      });
      return c.json({ configured: provider.configured, providerId: provider.id, status: provider.status });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/channels", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    try {
      const liveChannels = await deps.bridge.listChannels({ ownerId: auth.ownerId, installation: auth.snapshot.installation });
      return c.json({ channels: mergeLiveChannels(auth.snapshot.channels, liveChannels) });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.post("/channels/:channelId/action", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const params = ChannelIdParamSchema.safeParse({ channelId: c.req.param("channelId") });
    if (!params.success) return c.json(genericHermesError("invalid_request", "Request path is invalid"), status(400));
    const parsed = await parseJson(c, ChannelActionInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const saved = await withActionLock(activeActions, `${auth.ownerId}:channel:${params.data.channelId}`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        const result = await deps.bridge.runChannelAction({ ownerId: auth.ownerId, installation: currentSnapshot.installation, channelId: params.data.channelId, action: parsed.value });
        const channel = await deps.repository.upsertChannel(auth.ownerId, result.channel, principal.userId);
        return { channel, pairing: result.pairing };
      });
      await deps.eventHub?.publish(auth.ownerId, {
        type: "channel.updated",
        installationId: auth.snapshot.installation?.id,
        payload: {
          id: saved.channel.id,
          platform: saved.channel.platform,
          status: saved.channel.status,
          enabled: saved.channel.enabled,
          configured: saved.channel.configured,
          allowedSenderPolicy: saved.channel.allowedSenderPolicy,
          lastCheckedAt: saved.channel.lastCheckedAt,
          updatedAt: saved.channel.updatedAt,
          pairing: saved.pairing,
        },
      });
      return c.json({
        channel: saved.channel,
        operation: { id: `op_${randomUUID()}`, status: "complete", message: "Channel updated", pairing: saved.pairing },
      });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/sessions", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const query = SessionQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(genericHermesError("invalid_request", "Request query is invalid"), status(400));
    const filteredSessions = auth.snapshot.sessions
      .filter((session) => !query.data.status || session.status === query.data.status);
    const unfilteredIndex = query.data.cursor ? auth.snapshot.sessions.findIndex((session) => session.id === query.data.cursor) : -1;
    if (query.data.cursor && unfilteredIndex < 0) return c.json(genericHermesError("invalid_request", "Cursor not found"), status(400));
    const cursorIndex = query.data.cursor ? filteredSessions.findIndex((session) => session.id === query.data.cursor) : -1;
    if (query.data.cursor && cursorIndex < 0) return c.json(genericHermesError("invalid_request", "Cursor is outside the filtered result"), status(400));
    const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const sessions = filteredSessions.slice(startIndex, startIndex + query.data.limit);
    const nextCursor = startIndex + query.data.limit < filteredSessions.length ? sessions.at(-1)?.id ?? null : null;
    return c.json({ sessions, nextCursor });
  }));

  app.post("/sessions", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, CreateSessionInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const existing = auth.snapshot.sessions.find((session) => session.clientRequestIds?.includes(parsed.value.clientRequestId));
      if (existing) return c.json({ session: existing });
      const saved = await withActionLock(activeActions, `${auth.ownerId}:session-create:${parsed.value.clientRequestId}`, actionLockOptions, async () => {
        const current = await deps.repository.getSnapshot(auth.ownerId);
        const duplicate = current.sessions.find((session) => session.clientRequestIds?.includes(parsed.value.clientRequestId));
        if (duplicate) return duplicate;
        const session = await deps.bridge.createSession({ ownerId: auth.ownerId, installation: current.installation, operatorId: principal.userId, payload: parsed.value });
        return await deps.repository.upsertSession(auth.ownerId, { ...session, clientRequestIds: [parsed.value.clientRequestId] });
      });
      await deps.eventHub?.publish(auth.ownerId, { type: "session.event", installationId: saved.installationId, sessionId: saved.id, payload: { kind: "session_status", status: saved.status } });
      return c.json({ session: saved });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.post("/sessions/:sessionId/prompt", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const params = SessionIdParamSchema.safeParse({ sessionId: c.req.param("sessionId") });
    if (!params.success) return c.json(genericHermesError("invalid_request", "Request path is invalid"), status(400));
    const parsed = await parseJson(c, SendPromptInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const session = await deps.repository.getSession(auth.ownerId, params.data.sessionId);
      if (!session) return c.json(genericHermesError("not_found", "Session not found"), status(404));
      if (parsed.value.clientRequestId && session.clientRequestIds?.includes(parsed.value.clientRequestId)) return c.json({ session });
      const updated = await withActionLock(activeActions, `${auth.ownerId}:session:${session.id}`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        const current = currentSnapshot.sessions.find((item) => item.id === session.id);
        if (!current) throw new HermesBridgeError("operation_failed");
        if (parsed.value.clientRequestId && current.clientRequestIds?.includes(parsed.value.clientRequestId)) return current;
        const next = await deps.bridge.sendPrompt({ ownerId: auth.ownerId, installation: currentSnapshot.installation, operatorId: principal.userId, session: current, payload: parsed.value });
        const clientRequestIds = parsed.value.clientRequestId
          ? [...(current.clientRequestIds ?? []), parsed.value.clientRequestId].slice(-50)
          : current.clientRequestIds;
        return await deps.repository.upsertSession(auth.ownerId, { ...next, clientRequestIds });
      });
      await deps.eventHub?.publish(auth.ownerId, { type: "session.event", installationId: updated.installationId, sessionId: updated.id, payload: { kind: "session_status", status: updated.status } });
      return c.json({ session: updated });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.post("/approvals/:approvalId/decision", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    const params = ApprovalIdParamSchema.safeParse({ approvalId: c.req.param("approvalId") });
    if (!params.success) return c.json(genericHermesError("invalid_request", "Request path is invalid"), status(400));
    const parsed = await parseJson(c, ApprovalDecisionInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const updated = await withActionLock(activeActions, `${auth.ownerId}:approval:${params.data.approvalId}`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        const approval = currentSnapshot.approvals.find((item) => item.id === params.data.approvalId);
        if (!approval) throw new HermesBridgeError("not_found", "Approval not found");
        if (approval.status !== "pending") throw new HermesBridgeError("conflict", "Approval is no longer pending");
        const decided = await deps.bridge.decideApproval({ ownerId: auth.ownerId, installation: currentSnapshot.installation, operatorId: principal.userId, approval, payload: parsed.value });
        return await deps.repository.upsertApproval(auth.ownerId, decided);
      });
      await deps.eventHub?.publish(auth.ownerId, { type: "approval.updated", installationId: auth.snapshot.installation?.id, sessionId: updated.sessionId, payload: { approvalId: updated.id, status: updated.status } });
      return c.json({ approval: updated });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/capabilities", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    try {
      const capabilities = await deps.bridge.listCapabilities({ ownerId: auth.ownerId, installation: auth.snapshot.installation });
      return c.json({ capabilities: mergeLiveCapabilities(auth.snapshot.capabilities, capabilities) });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.post("/gateway/action", limited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOwner(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, GatewayActionInputSchema);
    if (!parsed.ok) return parsed.response;
    try {
      const { operation, installation } = await withActionLock(activeActions, `${auth.ownerId}:gateway`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        const result = await deps.bridge.runGatewayAction({ ownerId: auth.ownerId, installation: currentSnapshot.installation, action: parsed.value });
        if (currentSnapshot.installation && result.patch) {
          await deps.repository.applyInstallationPatch(auth.ownerId, result.patch);
        }
        return { operation: result, installation: currentSnapshot.installation };
      });
      await appendOperatorEvent(deps, auth.ownerId, {
        installationId: installation?.id ?? defaultHermesInstallation(auth.ownerId).id,
        actorId: principal.userId,
        category: parsed.value.type === "update" ? "update" : "gateway",
        severity: "info",
        message: "Gateway action accepted",
      });
      return c.json({ operation });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/audit", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    return c.json({ events: auth.snapshot.events });
  }));

  app.get("/export", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOwner(c, deps, principal);
    if (!auth.ok) return auth.response;
    return c.json(publicSnapshot(auth.snapshot));
  }));

  app.post("/recover", emptyLimited, (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOwner(c, deps, principal);
    if (!auth.ok) return auth.response;
    const parsed = await parseJson(c, EmptyBodySchema);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await withActionLock(activeActions, `${auth.ownerId}:recover`, actionLockOptions, async () => {
        const currentSnapshot = await deps.repository.getSnapshot(auth.ownerId);
        return deps.bridge.recover({ ownerId: auth.ownerId, installation: currentSnapshot.installation });
      });
      await appendOperatorEvent(deps, auth.ownerId, {
        installationId: auth.snapshot.installation?.id ?? defaultHermesInstallation(auth.ownerId).id,
        actorId: principal.userId,
        category: "recovery",
        severity: "info",
        message: "Recovery completed",
      });
      return c.json({ recovery: result });
    } catch (err: unknown) {
      return mapError(c, err);
    }
  }));

  app.get("/events", (c) => withPrincipal(c, deps, async (principal) => {
    const auth = await requireOperator(c, deps, principal);
    if (!auth.ok) return auth.response;
    let subscriberId: string | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        subscriberId = `sub_${randomUUID()}`;
        let streamClosed = false;
        const cleanup = () => {
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          if (subscriberId) {
            deps.eventHub?.unsubscribe(subscriberId);
            subscriberId = null;
          }
        };
        const closeController = () => {
          if (streamClosed) return;
          streamClosed = true;
          try {
            controller.close();
          } catch (err: unknown) {
            console.warn("[hermes] SSE close failed:", err instanceof Error ? err.message : String(err));
          }
        };
        const send = (event: HermesStreamEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        for (const event of deps.eventHub?.retained(auth.ownerId) ?? []) send(event);
        deps.eventHub?.subscribe({
          id: subscriberId,
          ownerId: auth.ownerId,
          send,
          close: () => {
            cleanup();
            closeController();
          },
        });
        heartbeat = setInterval(() => {
          if (subscriberId) deps.eventHub?.touch(subscriberId);
          try {
            send({ type: "heartbeat", id: `hb_${randomUUID()}`, createdAt: new Date().toISOString(), payload: {} });
          } catch (err: unknown) {
            console.warn("[hermes] SSE heartbeat failed:", err instanceof Error ? err.message : String(err));
            cleanup();
            closeController();
          }
        }, 30_000);
      },
      cancel() {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (subscriberId) {
          deps.eventHub?.unsubscribe(subscriberId);
          subscriberId = null;
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
    });
  }));

  return app;
}
