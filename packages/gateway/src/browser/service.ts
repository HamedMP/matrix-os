import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod/v4";
import {
  BrowserRepositoryError,
  type BrowserAuditEvent,
  type BrowserAuditEventType,
  type BrowserAuditPage,
  type BrowserDownloadRecord,
  type BrowserGrantRecord,
  type BrowserGrantScope,
  type BrowserProfileClearScope,
  type BrowserProfileRecord,
  type BrowserRepository,
  type BrowserSessionRecord,
  type BrowserTabRecord,
} from "./repository.js";
import {
  createBrowserStreamTokenSecret,
  signBrowserStreamToken,
  verifyBrowserStreamToken,
  type BrowserStreamTokenClaims,
} from "./stream-token.js";

export class BrowserSafeError extends Error {
  constructor(
    public readonly code: string,
    message = "Browser is unavailable right now.",
  ) {
    super(message);
    this.name = "BrowserSafeError";
  }
}

export function toBrowserSafeError(error: unknown): BrowserSafeError {
  if (error instanceof BrowserSafeError) return error;
  if (error instanceof BrowserRepositoryError) {
    return new BrowserSafeError(error.message, "Browser request is invalid.");
  }
  if (error instanceof ZodError) {
    return new BrowserSafeError("validation_error", "Browser request is invalid.");
  }
  if (error instanceof HTTPException && error.status === 413) {
    return new BrowserSafeError("payload_too_large", "Browser request is too large.");
  }
  return new BrowserSafeError("internal_error");
}

export class BrowserService {
  private readonly repo: BrowserRepository;
  private readonly streamTokenSecret: string;

  constructor(opts: { repo: BrowserRepository; streamTokenSecret?: string }) {
    this.repo = opts.repo;
    this.streamTokenSecret = opts.streamTokenSecret ?? createBrowserStreamTokenSecret();
  }

  capability() {
    return {
      available: true,
      capacityState: "ok",
      activeSessionCount: 0,
      limits: { maxSessions: 1, maxTabs: 12, maxStreams: 3 },
    };
  }

  async createSession(input: {
    ownerId: string;
    profileName: string;
    deviceId: string;
    surface: "canvas" | "standalone";
    targetUrl?: string;
    now?: number;
  }): Promise<{
    session: BrowserSessionRecord & {
      mediaMode: "webrtc";
      protocolVersion: 1;
    };
    streamToken: string;
    wsUrl: string;
  }> {
    const session = await this.repo.createOrResumeSession({
      ownerId: input.ownerId,
      profileName: input.profileName,
      deviceId: input.deviceId,
      now: input.now,
    });
    if (input.targetUrl) {
      await this.repo.addAuditEvent({
        id: `audit_${randomUUID()}`,
        ownerId: input.ownerId,
        eventType: "navigation.attempted",
        createdAt: new Date(input.now ?? Date.now()).toISOString(),
        metadata: {
          sessionId: session.id,
          profileName: input.profileName,
          surface: input.surface,
          url: input.targetUrl,
        },
      });
    }
    return {
      session: {
        ...session,
        mediaMode: "webrtc",
        protocolVersion: 1,
      },
      streamToken: signBrowserStreamToken({
        secret: this.streamTokenSecret,
        ownerId: input.ownerId,
        sessionId: session.id,
        now: input.now,
      }),
      wsUrl: `/api/browser/sessions/${session.id}/ws`,
    };
  }

  verifyStreamToken(input: {
    token: string | null | undefined;
    sessionId: string;
    now?: number;
  }): BrowserStreamTokenClaims {
    return verifyBrowserStreamToken({
      secret: this.streamTokenSecret,
      token: input.token,
      expectedSessionId: input.sessionId,
      now: input.now,
    });
  }

  async clearProfile(input: {
    ownerId: string;
    profileName: string;
    scopes: BrowserProfileClearScope[];
    now?: number;
  }): Promise<BrowserProfileRecord> {
    const sessions = await this.repo.listSessions(input.ownerId);
    for (const session of sessions) {
      if (session.profileName === input.profileName && session.state === "active") {
        await this.repo.closeSession({
          ownerId: input.ownerId,
          sessionId: session.id,
          state: "closed",
          now: input.now,
        });
      }
    }
    return this.repo.clearProfile(input);
  }

  async listSessions(input: { ownerId: string }): Promise<BrowserSessionRecord[]> {
    return this.repo.listSessions(input.ownerId);
  }

  async closeSession(input: {
    ownerId: string;
    sessionId: string;
    state?: BrowserSessionRecord["state"];
    now?: number;
  }): Promise<BrowserSessionRecord | null> {
    return this.repo.closeSession(input);
  }

  async takeoverSession(input: {
    ownerId: string;
    sessionId: string;
    deviceId: string;
    now?: number;
  }): Promise<{
    session: BrowserSessionRecord & {
      mediaMode: "webrtc";
      protocolVersion: 1;
    };
    streamToken: string;
    wsUrl: string;
  }> {
    const current = await this.repo.getSession(input.ownerId, input.sessionId);
    if (!current) {
      throw new BrowserSafeError("session_not_found", "Browser session was not found.");
    }
    await this.repo.closeSession({
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      state: "recoverable",
      now: input.now,
    });
    await recordTakeover(this.repo, {
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      now: input.now,
    });
    const session = await this.repo.createOrResumeSession({
      ownerId: input.ownerId,
      profileName: current.profileName,
      deviceId: input.deviceId,
      now: input.now,
    });
    return {
      session: {
        ...session,
        mediaMode: "webrtc",
        protocolVersion: 1,
      },
      streamToken: signBrowserStreamToken({
        secret: this.streamTokenSecret,
        ownerId: input.ownerId,
        sessionId: session.id,
        now: input.now,
      }),
      wsUrl: `/api/browser/sessions/${session.id}/ws`,
    };
  }

  async upsertTab(input: {
    ownerId: string;
    sessionId: string;
    tabId?: string;
    url: string;
    title?: string | null;
    order?: number;
    now?: number;
  }): Promise<BrowserTabRecord> {
    return this.repo.upsertTab(input);
  }

  async listTabs(input: { ownerId: string; sessionId: string }): Promise<BrowserTabRecord[]> {
    return this.repo.listTabs(input.ownerId, input.sessionId);
  }

  async createDownload(input: {
    ownerId: string;
    sessionId: string;
    filename: string;
    stagedPath?: string | null;
    now?: number;
  }): Promise<BrowserDownloadRecord> {
    return this.repo.createDownload(input);
  }

  async completeDownload(input: {
    ownerId: string;
    downloadId: string;
    completedPath: string;
    now?: number;
  }): Promise<BrowserDownloadRecord | null> {
    return this.repo.completeDownload(input);
  }

  async listDownloads(input: { ownerId: string }): Promise<BrowserDownloadRecord[]> {
    return this.repo.listDownloads(input.ownerId);
  }

  async deleteDownload(input: { ownerId: string; downloadId: string; now?: number }): Promise<BrowserDownloadRecord | null> {
    return this.repo.deleteDownload(input);
  }

  async listAudit(input: {
    ownerId: string;
    limit?: number;
    cursor?: string;
    eventType?: BrowserAuditEventType;
  }): Promise<BrowserAuditPage> {
    return this.repo.listAuditPage(input);
  }

  async createGrant(input: {
    ownerId: string;
    sessionId: string;
    scopes: BrowserGrantScope[];
    domains: string[];
    now?: number;
    expiresAt?: string;
  }): Promise<BrowserGrantRecord> {
    return this.repo.createGrant(input);
  }

  async listActiveGrants(input: { ownerId: string; now?: number }): Promise<BrowserGrantRecord[]> {
    return this.repo.listActiveGrants(input.ownerId, input.now);
  }

  async revokeGrant(input: { ownerId: string; grantId: string; now?: number }): Promise<BrowserGrantRecord | null> {
    return this.repo.revokeGrant(input);
  }

  async authorizeAgentAction(input: {
    ownerId: string;
    sessionId: string;
    action: BrowserGrantScope;
    url?: string;
    now?: number;
  }): Promise<BrowserGrantRecord> {
    const hostname = input.url ? new URL(input.url).hostname.toLowerCase() : null;
    const grant = (await this.repo.listActiveGrants(input.ownerId, input.now)).find((candidate) =>
      candidate.sessionId === input.sessionId &&
      candidate.scopes.includes(input.action) &&
      (!hostname || candidate.domains.some((domain) => domainMatches(hostname, domain)))
    );
    if (!grant) {
      throw new BrowserSafeError("agent_grant_required", "Browser permission is required.");
    }
    await this.repo.addAuditEvent({
      id: `audit_${randomUUID()}`,
      ownerId: input.ownerId,
      eventType: "agent.access",
      createdAt: new Date(input.now ?? Date.now()).toISOString(),
      metadata: {
        sessionId: input.sessionId,
        action: input.action,
        host: hostname,
      },
    });
    return grant;
  }
}

function domainMatches(hostname: string, grantDomain: string): boolean {
  const domain = grantDomain.toLowerCase();
  if (domain.startsWith("*.")) {
    const suffix = domain.slice(1);
    return hostname.endsWith(suffix) && hostname !== domain.slice(2);
  }
  return hostname === domain;
}

export function createTakeoverAuditEvent(opts: {
  ownerId: string;
  sessionId: string;
  deviceId: string;
  now?: number;
}): BrowserAuditEvent {
  return {
    id: `audit_${randomUUID()}`,
    ownerId: opts.ownerId,
    eventType: "session.taken_over",
    createdAt: new Date(opts.now ?? Date.now()).toISOString(),
    metadata: {
      sessionId: opts.sessionId,
      deviceId: opts.deviceId.slice(0, 64),
    },
  };
}

export async function recordTakeover(repo: BrowserRepository, opts: {
  ownerId: string;
  sessionId: string;
  deviceId: string;
  now?: number;
}): Promise<BrowserAuditEvent> {
  const event = createTakeoverAuditEvent(opts);
  await repo.addAuditEvent(event);
  return event;
}
