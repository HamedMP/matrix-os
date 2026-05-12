import { randomUUID } from "node:crypto";
import { Kysely, sql, type ColumnType, type Selectable, type Transaction } from "kysely";

export type BrowserAuditEventType =
  | "session.created"
  | "session.closed"
  | "session.idle_hibernated"
  | "session.taken_over"
  | "navigation.attempted"
  | "navigation.blocked"
  | "download.started"
  | "download.completed"
  | "download.failed"
  | "profile.cleared"
  | "permission.granted"
  | "permission.revoked"
  | "agent.access";

export type BrowserProfileClearScope =
  | "cookies"
  | "localStorage"
  | "sessionStorage"
  | "indexedDb"
  | "cache"
  | "serviceWorkers"
  | "sitePermissions"
  | "savedFormData"
  | "savedPasswords"
  | "history"
  | "downloads";

export type BrowserGrantScope =
  | "read_dom"
  | "screenshot"
  | "navigate"
  | "download"
  | "automate_input";

export interface BrowserAuditEvent {
  id: string;
  ownerId: string;
  eventType: BrowserAuditEventType;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface BrowserProfileRecord {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  clearedScopes: BrowserProfileClearScope[];
}

export interface BrowserSessionRecord {
  id: string;
  ownerId: string;
  profileId: string;
  profileName: string;
  state: "active" | "closed" | "hibernated" | "recoverable";
  currentTabId: string | null;
  lockDeviceId: string;
  takeoverRequired: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface BrowserGrantRecord {
  id: string;
  ownerId: string;
  sessionId: string;
  scopes: BrowserGrantScope[];
  domains: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  expiresReason: "matrix_session" | "ttl" | "manual";
}

export interface BrowserTabRecord {
  id: string;
  ownerId: string;
  sessionId: string;
  url: string;
  title: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export type BrowserDownloadState = "staged" | "complete" | "failed" | "deleted";

export interface BrowserDownloadRecord {
  id: string;
  ownerId: string;
  sessionId: string;
  filename: string;
  state: BrowserDownloadState;
  stagedPath: string | null;
  completedPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserAuditPage {
  events: BrowserAuditEvent[];
  nextCursor: string | null;
}

export interface CreateBrowserSessionInput {
  ownerId: string;
  profileName: string;
  deviceId: string;
  now?: number;
}

export interface CreateBrowserGrantInput {
  ownerId: string;
  sessionId: string;
  scopes: BrowserGrantScope[];
  domains: string[];
  now?: number;
  expiresAt?: string;
}

export interface UpsertBrowserTabInput {
  ownerId: string;
  sessionId: string;
  tabId?: string;
  url: string;
  title?: string | null;
  order?: number;
  now?: number;
}

export interface CreateBrowserDownloadInput {
  ownerId: string;
  sessionId: string;
  filename: string;
  stagedPath?: string | null;
  now?: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface BrowserRepository {
  bootstrap?(): Promise<void>;
  destroy?(): Promise<void>;
  upsertProfile(ownerId: string, name: string, now?: number): MaybePromise<BrowserProfileRecord>;
  getProfile(ownerId: string, name: string): MaybePromise<BrowserProfileRecord | null>;
  clearProfile(opts: {
    ownerId: string;
    profileName: string;
    scopes: BrowserProfileClearScope[];
    now?: number;
  }): MaybePromise<BrowserProfileRecord>;
  createOrResumeSession(input: CreateBrowserSessionInput): MaybePromise<BrowserSessionRecord>;
  takeoverSession(input: {
    ownerId: string;
    sessionId: string;
    deviceId: string;
    now?: number;
  }): MaybePromise<BrowserSessionRecord>;
  listSessions(ownerId: string): MaybePromise<BrowserSessionRecord[]>;
  getSession(ownerId: string, sessionId: string): MaybePromise<BrowserSessionRecord | null>;
  closeSession(opts: { ownerId: string; sessionId: string; state?: BrowserSessionRecord["state"]; now?: number }): MaybePromise<BrowserSessionRecord | null>;
  upsertTab(input: UpsertBrowserTabInput): MaybePromise<BrowserTabRecord>;
  listTabs(ownerId: string, sessionId: string): MaybePromise<BrowserTabRecord[]>;
  createDownload(input: CreateBrowserDownloadInput): MaybePromise<BrowserDownloadRecord>;
  completeDownload(opts: { ownerId: string; downloadId: string; completedPath: string; now?: number }): MaybePromise<BrowserDownloadRecord | null>;
  failDownload(opts: { ownerId: string; downloadId: string; now?: number }): MaybePromise<BrowserDownloadRecord | null>;
  listDownloads(ownerId: string): MaybePromise<BrowserDownloadRecord[]>;
  deleteDownload(opts: { ownerId: string; downloadId: string; now?: number }): MaybePromise<BrowserDownloadRecord | null>;
  createGrant(input: CreateBrowserGrantInput): MaybePromise<BrowserGrantRecord>;
  listActiveGrants(ownerId: string, now?: number): MaybePromise<BrowserGrantRecord[]>;
  revokeGrant(opts: { ownerId: string; grantId: string; now?: number }): MaybePromise<BrowserGrantRecord | null>;
  addAuditEvent(event: BrowserAuditEvent): MaybePromise<void>;
  listAuditEvents(ownerId: string): MaybePromise<BrowserAuditEvent[]>;
  listAuditPage(opts: { ownerId: string; limit?: number; cursor?: string; eventType?: BrowserAuditEventType }): MaybePromise<BrowserAuditPage>;
  pruneAuditEvents(opts: { ownerId: string; now?: number; retentionDays?: number }): MaybePromise<number>;
}

const MAX_AUDIT_EVENTS = 10_000;
const MAX_GRANTS = 5_000;
const MAX_IN_MEMORY_PROFILES = 2_000;
const MAX_IN_MEMORY_SESSIONS = 2_000;
const MAX_IN_MEMORY_TABS = 10_000;
const MAX_IN_MEMORY_DOWNLOADS = 10_000;
const SAFE_DOMAIN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export class BrowserRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserRepositoryError";
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function iso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function profileKey(ownerId: string, profileName: string): string {
  return `${ownerId}:${profileName}`;
}

function evictOldestMapEntries<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) break;
    map.delete(first);
  }
}

export class InMemoryBrowserRepository implements BrowserRepository {
  private readonly profiles = new Map<string, BrowserProfileRecord>();
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly tabs = new Map<string, BrowserTabRecord>();
  private readonly downloads = new Map<string, BrowserDownloadRecord>();
  private readonly grants = new Map<string, BrowserGrantRecord>();
  private readonly audit: BrowserAuditEvent[] = [];

  upsertProfile(ownerId: string, name: string, now = Date.now()): BrowserProfileRecord {
    const key = profileKey(ownerId, name);
    const existing = this.profiles.get(key);
    if (existing) return existing;
    const createdAt = iso(now);
    const profile: BrowserProfileRecord = {
      id: id("browser_profile"),
      ownerId,
      name,
      createdAt,
      updatedAt: createdAt,
      clearedScopes: [],
    };
    this.profiles.set(key, profile);
    evictOldestMapEntries(this.profiles, MAX_IN_MEMORY_PROFILES);
    return profile;
  }

  getProfile(ownerId: string, name: string): BrowserProfileRecord | null {
    return this.profiles.get(profileKey(ownerId, name)) ?? null;
  }

  clearProfile(opts: {
    ownerId: string;
    profileName: string;
    scopes: BrowserProfileClearScope[];
    now?: number;
  }): BrowserProfileRecord {
    const profile = this.upsertProfile(opts.ownerId, opts.profileName, opts.now);
    for (const session of this.sessions.values()) {
      if (
        session.ownerId === opts.ownerId &&
        session.profileId === profile.id &&
        session.state === "active"
      ) {
        session.state = "closed";
        session.updatedAt = iso(opts.now);
        session.lastActivityAt = iso(opts.now);
      }
    }
    profile.clearedScopes = [...opts.scopes];
    profile.updatedAt = iso(opts.now);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: opts.ownerId,
      eventType: "profile.cleared",
      createdAt: iso(opts.now),
      metadata: {
        profileName: opts.profileName,
        scopes: [...opts.scopes],
      },
    });
    return { ...profile, clearedScopes: [...profile.clearedScopes] };
  }

  createOrResumeSession(input: CreateBrowserSessionInput): BrowserSessionRecord {
    const profile = this.upsertProfile(input.ownerId, input.profileName, input.now);
    const existing = [...this.sessions.values()].find((session) =>
      session.ownerId === input.ownerId &&
      session.profileId === profile.id &&
      session.state === "active"
    );
    const now = iso(input.now);
    if (existing) {
      existing.takeoverRequired = existing.lockDeviceId !== input.deviceId;
      existing.updatedAt = now;
      existing.lastActivityAt = now;
      return { ...existing };
    }
    const session: BrowserSessionRecord = {
      id: id("browser_session"),
      ownerId: input.ownerId,
      profileId: profile.id,
      profileName: input.profileName,
      state: "active",
      currentTabId: null,
      lockDeviceId: input.deviceId,
      takeoverRequired: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(session.id, session);
    evictOldestMapEntries(this.sessions, MAX_IN_MEMORY_SESSIONS);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "session.created",
      createdAt: now,
      metadata: { sessionId: session.id, profileName: input.profileName },
    });
    return { ...session };
  }

  takeoverSession(input: { ownerId: string; sessionId: string; deviceId: string; now?: number }): BrowserSessionRecord {
    const current = this.sessions.get(input.sessionId);
    if (!current || current.ownerId !== input.ownerId || current.state !== "active") {
      throw new BrowserRepositoryError("session_not_found");
    }
    const now = iso(input.now);
    for (const session of this.sessions.values()) {
      if (
        session.ownerId === input.ownerId &&
        session.profileId === current.profileId &&
        session.state === "active"
      ) {
        session.state = "recoverable";
        session.takeoverRequired = false;
        session.updatedAt = now;
        session.lastActivityAt = now;
      }
    }
    const replacement: BrowserSessionRecord = {
      id: id("browser_session"),
      ownerId: input.ownerId,
      profileId: current.profileId,
      profileName: current.profileName,
      state: "active",
      currentTabId: null,
      lockDeviceId: input.deviceId,
      takeoverRequired: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(replacement.id, replacement);
    evictOldestMapEntries(this.sessions, MAX_IN_MEMORY_SESSIONS);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "session.closed",
      createdAt: now,
      metadata: { sessionId: input.sessionId },
    });
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "session.taken_over",
      createdAt: now,
      metadata: {
        sessionId: input.sessionId,
        replacementSessionId: replacement.id,
        deviceId: input.deviceId.slice(0, 64),
      },
    });
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "session.created",
      createdAt: now,
      metadata: { sessionId: replacement.id, profileName: replacement.profileName },
    });
    return { ...replacement };
  }

  listSessions(ownerId: string): BrowserSessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId)
      .map((session) => ({ ...session }));
  }

  getSession(ownerId: string, sessionId: string): BrowserSessionRecord | null {
    const session = this.sessions.get(sessionId);
    return session?.ownerId === ownerId ? { ...session } : null;
  }

  closeSession(opts: {
    ownerId: string;
    sessionId: string;
    state?: BrowserSessionRecord["state"];
    now?: number;
  }): BrowserSessionRecord | null {
    const session = this.sessions.get(opts.sessionId);
    if (!session || session.ownerId !== opts.ownerId) return null;
    session.state = opts.state ?? "closed";
    session.updatedAt = iso(opts.now);
    session.lastActivityAt = iso(opts.now);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: opts.ownerId,
      eventType: opts.state === "hibernated" ? "session.idle_hibernated" : "session.closed",
      createdAt: iso(opts.now),
      metadata: { sessionId: opts.sessionId },
    });
    return { ...session };
  }

  upsertTab(input: UpsertBrowserTabInput): BrowserTabRecord {
    const now = iso(input.now);
    const tabId = input.tabId ?? id("browser_tab");
    const existing = this.tabs.get(tabId);
    if (existing && (existing.ownerId !== input.ownerId || existing.sessionId !== input.sessionId)) {
      throw new BrowserRepositoryError("tab_session_mismatch");
    }
    const tab: BrowserTabRecord = {
      id: tabId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      url: input.url,
      title: input.title ?? existing?.title ?? null,
      order: input.order ?? existing?.order ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.tabs.set(tab.id, tab);
    evictOldestMapEntries(this.tabs, MAX_IN_MEMORY_TABS);
    const session = this.sessions.get(input.sessionId);
    if (session?.ownerId === input.ownerId) {
      session.currentTabId ??= tab.id;
      session.updatedAt = now;
      session.lastActivityAt = now;
    }
    return { ...tab };
  }

  listTabs(ownerId: string, sessionId: string): BrowserTabRecord[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.ownerId === ownerId && tab.sessionId === sessionId)
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .map((tab) => ({ ...tab }));
  }

  createDownload(input: CreateBrowserDownloadInput): BrowserDownloadRecord {
    const now = iso(input.now);
    const download: BrowserDownloadRecord = {
      id: id("browser_download"),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      filename: input.filename,
      state: "staged",
      stagedPath: input.stagedPath ?? null,
      completedPath: null,
      createdAt: now,
      updatedAt: now,
    };
    this.downloads.set(download.id, download);
    evictOldestMapEntries(this.downloads, MAX_IN_MEMORY_DOWNLOADS);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "download.started",
      createdAt: now,
      metadata: { downloadId: download.id, sessionId: input.sessionId, filename: input.filename },
    });
    return { ...download };
  }

  completeDownload(opts: { ownerId: string; downloadId: string; completedPath: string; now?: number }): BrowserDownloadRecord | null {
    const download = this.downloads.get(opts.downloadId);
    if (!download || download.ownerId !== opts.ownerId || download.state !== "staged") return null;
    download.state = "complete";
    download.completedPath = opts.completedPath;
    download.updatedAt = iso(opts.now);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: opts.ownerId,
      eventType: "download.completed",
      createdAt: iso(opts.now),
      metadata: { downloadId: opts.downloadId, filename: download.filename },
    });
    return { ...download };
  }

  failDownload(opts: { ownerId: string; downloadId: string; now?: number }): BrowserDownloadRecord | null {
    const download = this.downloads.get(opts.downloadId);
    if (!download || download.ownerId !== opts.ownerId || download.state !== "staged") return null;
    download.state = "failed";
    download.updatedAt = iso(opts.now);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: opts.ownerId,
      eventType: "download.failed",
      createdAt: iso(opts.now),
      metadata: { downloadId: opts.downloadId, filename: download.filename },
    });
    return { ...download };
  }

  listDownloads(ownerId: string): BrowserDownloadRecord[] {
    return [...this.downloads.values()]
      .filter((download) => download.ownerId === ownerId && download.state !== "deleted")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((download) => ({ ...download }));
  }

  deleteDownload(opts: { ownerId: string; downloadId: string; now?: number }): BrowserDownloadRecord | null {
    const download = this.downloads.get(opts.downloadId);
    if (!download || download.ownerId !== opts.ownerId) return null;
    download.state = "deleted";
    download.updatedAt = iso(opts.now);
    return { ...download };
  }

  createGrant(input: CreateBrowserGrantInput): BrowserGrantRecord {
    for (const domain of input.domains) {
      if (!SAFE_DOMAIN.test(domain)) {
        throw new BrowserRepositoryError("invalid_grant_domain");
      }
    }
    while (this.grants.size >= MAX_GRANTS) {
      const first = this.grants.keys().next().value as string | undefined;
      if (!first) break;
      this.grants.delete(first);
    }
    const now = input.now ?? Date.now();
    const grant: BrowserGrantRecord = {
      id: id("browser_grant"),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      scopes: [...input.scopes],
      domains: [...input.domains],
      createdAt: iso(now),
      expiresAt: input.expiresAt ?? iso(now + 8 * 60 * 60 * 1000),
      revokedAt: null,
      expiresReason: "ttl",
    };
    this.grants.set(grant.id, grant);
    this.addAuditEvent({
      id: id("audit"),
      ownerId: input.ownerId,
      eventType: "permission.granted",
      createdAt: iso(now),
      metadata: {
        grantId: grant.id,
        sessionId: input.sessionId,
        scopes: [...input.scopes],
        domains: [...input.domains],
      },
    });
    return { ...grant, scopes: [...grant.scopes], domains: [...grant.domains] };
  }

  listActiveGrants(ownerId: string, now = Date.now()): BrowserGrantRecord[] {
    return [...this.grants.values()]
      .filter((grant) =>
        grant.ownerId === ownerId &&
        grant.revokedAt === null &&
        Date.parse(grant.expiresAt) > now
      )
      .map((grant) => ({ ...grant, scopes: [...grant.scopes], domains: [...grant.domains] }));
  }

  revokeGrant(opts: { ownerId: string; grantId: string; now?: number }): BrowserGrantRecord | null {
    const grant = this.grants.get(opts.grantId);
    if (!grant || grant.ownerId !== opts.ownerId) return null;
    grant.revokedAt = iso(opts.now);
    grant.expiresReason = "manual";
    this.addAuditEvent({
      id: id("audit"),
      ownerId: opts.ownerId,
      eventType: "permission.revoked",
      createdAt: iso(opts.now),
      metadata: { grantId: opts.grantId },
    });
    return { ...grant, scopes: [...grant.scopes], domains: [...grant.domains] };
  }

  addAuditEvent(event: BrowserAuditEvent): void {
    this.audit.push(redactAuditEvent(event));
    while (this.audit.length > MAX_AUDIT_EVENTS) {
      this.audit.shift();
    }
  }

  listAuditEvents(ownerId: string): BrowserAuditEvent[] {
    return this.audit.filter((event) => event.ownerId === ownerId).map((event) => ({
      ...event,
      metadata: event.metadata ? { ...event.metadata } : undefined,
    }));
  }

  listAuditPage(opts: {
    ownerId: string;
    limit?: number;
    cursor?: string;
    eventType?: BrowserAuditEventType;
  }): BrowserAuditPage {
    const limit = clampLimit(opts.limit);
    const cursorTime = opts.cursor ? Date.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")) : Number.POSITIVE_INFINITY;
    const events = this.audit
      .filter((event) =>
        event.ownerId === opts.ownerId &&
        (!opts.eventType || event.eventType === opts.eventType) &&
        Date.parse(event.createdAt) < cursorTime
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit + 1);
    const page = events.slice(0, limit).map((event) => ({
      ...event,
      metadata: event.metadata ? { ...event.metadata } : undefined,
    }));
    return {
      events: page,
      nextCursor: events.length > limit ? encodeAuditCursor(page[page.length - 1]?.createdAt) : null,
    };
  }

  pruneAuditEvents(opts: { ownerId: string; now?: number; retentionDays?: number }): number {
    const cutoff = (opts.now ?? Date.now()) - (opts.retentionDays ?? 180) * 24 * 60 * 60 * 1000;
    const before = this.audit.length;
    for (let index = this.audit.length - 1; index >= 0; index -= 1) {
      const event = this.audit[index];
      if (event.ownerId === opts.ownerId && Date.parse(event.createdAt) < cutoff) {
        this.audit.splice(index, 1);
      }
    }
    return before - this.audit.length;
  }
}

export interface BrowserProfilesTable {
  id: string;
  owner_id: string;
  name: string;
  cleared_scopes: ColumnType<unknown, unknown | undefined, unknown>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserSessionsTable {
  id: string;
  owner_id: string;
  profile_id: string;
  profile_name: string;
  state: BrowserSessionRecord["state"];
  current_tab_id: string | null;
  lock_device_id: string;
  takeover_required: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  last_activity_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserTabsTable {
  id: string;
  owner_id: string;
  session_id: string;
  url: string;
  title: string | null;
  tab_order: number;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserStreamsTable {
  id: string;
  owner_id: string;
  session_id: string;
  surface_id: string;
  device_id: string;
  state: string;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  last_seen_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserDownloadsTable {
  id: string;
  owner_id: string;
  session_id: string;
  filename: string;
  state: BrowserDownloadState;
  staged_path: string | null;
  completed_path: string | null;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserGrantsTable {
  id: string;
  owner_id: string;
  session_id: string;
  scopes: ColumnType<unknown, unknown, unknown>;
  domains: ColumnType<unknown, unknown, unknown>;
  expires_reason: BrowserGrantRecord["expiresReason"];
  revoked_at: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
  expires_at: ColumnType<Date | string, Date | string, Date | string>;
}

export interface BrowserAuditEventsTable {
  id: string;
  owner_id: string;
  event_type: BrowserAuditEventType;
  metadata: ColumnType<unknown, unknown | undefined, unknown>;
  created_at: ColumnType<Date | string, Date | string | undefined, Date | string>;
}

export interface BrowserDatabase {
  browser_profiles: BrowserProfilesTable;
  browser_sessions: BrowserSessionsTable;
  browser_tabs: BrowserTabsTable;
  browser_streams: BrowserStreamsTable;
  browser_downloads: BrowserDownloadsTable;
  browser_grants: BrowserGrantsTable;
  browser_audit_events: BrowserAuditEventsTable;
}

type BrowserDb = Kysely<BrowserDatabase> | Transaction<BrowserDatabase>;

export class KyselyBrowserRepository implements BrowserRepository {
  constructor(private readonly kysely: Kysely<BrowserDatabase>) {}

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS browser_profiles (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cleared_scopes JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (owner_id, name)
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_profiles_owner ON browser_profiles(owner_id)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES browser_profiles(id) ON DELETE CASCADE,
        profile_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'hibernated', 'recoverable')),
        current_tab_id TEXT,
        lock_device_id TEXT NOT NULL,
        takeover_required BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_sessions_owner ON browser_sessions(owner_id, updated_at DESC)`.execute(this.kysely);
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_one_live_profile
      ON browser_sessions(owner_id, profile_id)
      WHERE state = 'active'
    `.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_tabs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        tab_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_tabs_session ON browser_tabs(owner_id, session_id, tab_order)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_streams (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
        surface_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_streams_session ON browser_streams(owner_id, session_id, last_seen_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_downloads (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        state TEXT NOT NULL,
        staged_path TEXT,
        completed_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_downloads_owner ON browser_downloads(owner_id, updated_at DESC)`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_grants (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        scopes JSONB NOT NULL,
        domains JSONB NOT NULL,
        expires_reason TEXT NOT NULL CHECK (expires_reason IN ('matrix_session', 'ttl', 'manual')),
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_grants_active ON browser_grants(owner_id, session_id, expires_at) WHERE revoked_at IS NULL`.execute(this.kysely);

    await sql`
      CREATE TABLE IF NOT EXISTS browser_audit_events (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(this.kysely);
    await sql`CREATE INDEX IF NOT EXISTS idx_browser_audit_owner_created ON browser_audit_events(owner_id, created_at DESC)`.execute(this.kysely);
  }

  async destroy(): Promise<void> {
    // The gateway owns and closes the shared app Kysely instance.
  }

  async upsertProfile(ownerId: string, name: string, now = Date.now()): Promise<BrowserProfileRecord> {
    return this.upsertProfileIn(this.kysely, ownerId, name, now);
  }

  async getProfile(ownerId: string, name: string): Promise<BrowserProfileRecord | null> {
    const row = await this.kysely
      .selectFrom("browser_profiles")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? toProfileRecord(row) : null;
  }

  async clearProfile(opts: {
    ownerId: string;
    profileName: string;
    scopes: BrowserProfileClearScope[];
    now?: number;
  }): Promise<BrowserProfileRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const profile = await this.upsertProfileIn(trx, opts.ownerId, opts.profileName, opts.now);
      await trx
        .updateTable("browser_sessions")
        .set({
          state: "closed",
          updated_at: iso(opts.now),
          last_activity_at: iso(opts.now),
        })
        .where("owner_id", "=", opts.ownerId)
        .where("profile_id", "=", profile.id)
        .where("state", "=", "active")
        .execute();
      const updated = await trx
        .updateTable("browser_profiles")
        .set({
          cleared_scopes: jsonb(opts.scopes),
          updated_at: iso(opts.now),
        })
        .where("id", "=", profile.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: opts.ownerId,
        eventType: "profile.cleared",
        createdAt: iso(opts.now),
        metadata: {
          profileName: opts.profileName,
          scopes: [...opts.scopes],
        },
      });
      return toProfileRecord(updated);
    });
  }

  async createOrResumeSession(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const profile = await this.upsertProfileIn(trx, input.ownerId, input.profileName, input.now);
      await sql`SELECT id FROM browser_profiles WHERE id = ${profile.id} FOR UPDATE`.execute(trx);
      const now = iso(input.now);
      const existing = await trx
        .selectFrom("browser_sessions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("profile_id", "=", profile.id)
        .where("state", "=", "active")
        .executeTakeFirst();
      if (existing) {
        const updated = await trx
          .updateTable("browser_sessions")
          .set({
            takeover_required: existing.lock_device_id !== input.deviceId,
            updated_at: now,
            last_activity_at: now,
          })
          .where("id", "=", existing.id)
          .where("owner_id", "=", input.ownerId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return toSessionRecord(updated);
      }

      const sessionId = id("browser_session");
      const inserted = await trx
        .insertInto("browser_sessions")
        .values({
          id: sessionId,
          owner_id: input.ownerId,
          profile_id: profile.id,
          profile_name: input.profileName,
          state: "active",
          current_tab_id: null,
          lock_device_id: input.deviceId,
          takeover_required: false,
          created_at: now,
          updated_at: now,
          last_activity_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "session.created",
        createdAt: now,
        metadata: { sessionId, profileName: input.profileName },
      });
      return toSessionRecord(inserted);
    });
  }

  async takeoverSession(input: { ownerId: string; sessionId: string; deviceId: string; now?: number }): Promise<BrowserSessionRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const now = iso(input.now);
      const current = await trx
        .selectFrom("browser_sessions")
        .selectAll()
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current || current.state !== "active") {
        throw new BrowserRepositoryError("session_not_found");
      }
      await sql`SELECT id FROM browser_profiles WHERE id = ${current.profile_id} FOR UPDATE`.execute(trx);
      await trx
        .updateTable("browser_sessions")
        .set({
          state: "recoverable",
          takeover_required: false,
          updated_at: now,
          last_activity_at: now,
        })
        .where("owner_id", "=", input.ownerId)
        .where("profile_id", "=", current.profile_id)
        .where("state", "=", "active")
        .execute();
      const sessionId = id("browser_session");
      const inserted = await trx
        .insertInto("browser_sessions")
        .values({
          id: sessionId,
          owner_id: input.ownerId,
          profile_id: current.profile_id,
          profile_name: current.profile_name,
          state: "active",
          current_tab_id: null,
          lock_device_id: input.deviceId,
          takeover_required: false,
          created_at: now,
          updated_at: now,
          last_activity_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "session.closed",
        createdAt: now,
        metadata: { sessionId: input.sessionId },
      });
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "session.taken_over",
        createdAt: now,
        metadata: {
          sessionId: input.sessionId,
          replacementSessionId: sessionId,
          deviceId: input.deviceId.slice(0, 64),
        },
      });
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "session.created",
        createdAt: now,
        metadata: { sessionId, profileName: current.profile_name },
      });
      return toSessionRecord(inserted);
    });
  }

  async listSessions(ownerId: string): Promise<BrowserSessionRecord[]> {
    const rows = await this.kysely
      .selectFrom("browser_sessions")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map(toSessionRecord);
  }

  async getSession(ownerId: string, sessionId: string): Promise<BrowserSessionRecord | null> {
    const row = await this.kysely
      .selectFrom("browser_sessions")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? toSessionRecord(row) : null;
  }

  async closeSession(opts: {
    ownerId: string;
    sessionId: string;
    state?: BrowserSessionRecord["state"];
    now?: number;
  }): Promise<BrowserSessionRecord | null> {
    return this.kysely.transaction().execute(async (trx) => {
      const state = opts.state ?? "closed";
      const timestamp = iso(opts.now);
      const row = await trx
        .updateTable("browser_sessions")
        .set({
          state,
          updated_at: timestamp,
          last_activity_at: timestamp,
        })
        .where("owner_id", "=", opts.ownerId)
        .where("id", "=", opts.sessionId)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: opts.ownerId,
        eventType: state === "hibernated" ? "session.idle_hibernated" : "session.closed",
        createdAt: timestamp,
        metadata: { sessionId: opts.sessionId },
      });
      return toSessionRecord(row);
    });
  }

  async upsertTab(input: UpsertBrowserTabInput): Promise<BrowserTabRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const now = iso(input.now);
      const tabId = input.tabId ?? id("browser_tab");
      const row = await trx
        .insertInto("browser_tabs")
        .values({
          id: tabId,
          owner_id: input.ownerId,
          session_id: input.sessionId,
          url: input.url,
          title: input.title ?? null,
          tab_order: input.order ?? 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column("id").doUpdateSet({
          url: input.url,
          title: input.title ?? null,
          tab_order: input.order ?? 0,
          updated_at: now,
        })
          .where("browser_tabs.owner_id", "=", input.ownerId)
          .where("browser_tabs.session_id", "=", input.sessionId))
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new BrowserRepositoryError("tab_session_mismatch");
      }
      await trx
        .updateTable("browser_sessions")
        .set({
          current_tab_id: tabId,
          updated_at: now,
          last_activity_at: now,
        })
        .where("owner_id", "=", input.ownerId)
        .where("id", "=", input.sessionId)
        .where((eb) => eb.or([
          eb("current_tab_id", "is", null),
          eb("current_tab_id", "=", tabId),
        ]))
        .execute();
      return toTabRecord(row);
    });
  }

  async listTabs(ownerId: string, sessionId: string): Promise<BrowserTabRecord[]> {
    const rows = await this.kysely
      .selectFrom("browser_tabs")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("session_id", "=", sessionId)
      .orderBy("tab_order", "asc")
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toTabRecord);
  }

  async createDownload(input: CreateBrowserDownloadInput): Promise<BrowserDownloadRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const now = iso(input.now);
      const row = await trx
        .insertInto("browser_downloads")
        .values({
          id: id("browser_download"),
          owner_id: input.ownerId,
          session_id: input.sessionId,
          filename: input.filename,
          state: "staged",
          staged_path: input.stagedPath ?? null,
          completed_path: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "download.started",
        createdAt: now,
        metadata: { downloadId: row.id, sessionId: input.sessionId, filename: input.filename },
      });
      return toDownloadRecord(row);
    });
  }

  async completeDownload(opts: { ownerId: string; downloadId: string; completedPath: string; now?: number }): Promise<BrowserDownloadRecord | null> {
    return this.kysely.transaction().execute(async (trx) => {
      const timestamp = iso(opts.now);
      const row = await trx
        .updateTable("browser_downloads")
        .set({
          state: "complete",
          completed_path: opts.completedPath,
          updated_at: timestamp,
        })
        .where("owner_id", "=", opts.ownerId)
        .where("id", "=", opts.downloadId)
        .where("state", "=", "staged")
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: opts.ownerId,
        eventType: "download.completed",
        createdAt: timestamp,
        metadata: { downloadId: opts.downloadId, filename: row.filename },
      });
      return toDownloadRecord(row);
    });
  }

  async failDownload(opts: { ownerId: string; downloadId: string; now?: number }): Promise<BrowserDownloadRecord | null> {
    return this.kysely.transaction().execute(async (trx) => {
      const timestamp = iso(opts.now);
      const row = await trx
        .updateTable("browser_downloads")
        .set({
          state: "failed",
          updated_at: timestamp,
        })
        .where("owner_id", "=", opts.ownerId)
        .where("id", "=", opts.downloadId)
        .where("state", "=", "staged")
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: opts.ownerId,
        eventType: "download.failed",
        createdAt: timestamp,
        metadata: { downloadId: opts.downloadId, filename: row.filename },
      });
      return toDownloadRecord(row);
    });
  }

  async listDownloads(ownerId: string): Promise<BrowserDownloadRecord[]> {
    const rows = await this.kysely
      .selectFrom("browser_downloads")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("state", "!=", "deleted")
      .orderBy("updated_at", "desc")
      .execute();
    return rows.map(toDownloadRecord);
  }

  async deleteDownload(opts: { ownerId: string; downloadId: string; now?: number }): Promise<BrowserDownloadRecord | null> {
    const row = await this.kysely
      .updateTable("browser_downloads")
      .set({
        state: "deleted",
        updated_at: iso(opts.now),
      })
      .where("owner_id", "=", opts.ownerId)
      .where("id", "=", opts.downloadId)
      .returningAll()
      .executeTakeFirst();
    return row ? toDownloadRecord(row) : null;
  }

  async createGrant(input: CreateBrowserGrantInput): Promise<BrowserGrantRecord> {
    validateGrantDomains(input.domains);
    return this.kysely.transaction().execute(async (trx) => {
      const now = input.now ?? Date.now();
      const grant: BrowserGrantRecord = {
        id: id("browser_grant"),
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        scopes: [...input.scopes],
        domains: [...input.domains],
        createdAt: iso(now),
        expiresAt: input.expiresAt ?? iso(now + 8 * 60 * 60 * 1000),
        revokedAt: null,
        expiresReason: "ttl",
      };
      const row = await trx
        .insertInto("browser_grants")
        .values({
          id: grant.id,
          owner_id: grant.ownerId,
          session_id: grant.sessionId,
          scopes: jsonb(grant.scopes),
          domains: jsonb(grant.domains),
          expires_reason: grant.expiresReason,
          revoked_at: null,
          created_at: grant.createdAt,
          expires_at: grant.expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: input.ownerId,
        eventType: "permission.granted",
        createdAt: grant.createdAt,
        metadata: {
          grantId: grant.id,
          sessionId: input.sessionId,
          scopes: [...input.scopes],
          domains: [...input.domains],
        },
      });
      return toGrantRecord(row);
    });
  }

  async listActiveGrants(ownerId: string, now = Date.now()): Promise<BrowserGrantRecord[]> {
    const rows = await this.kysely
      .selectFrom("browser_grants")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", iso(now))
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(toGrantRecord);
  }

  async revokeGrant(opts: { ownerId: string; grantId: string; now?: number }): Promise<BrowserGrantRecord | null> {
    return this.kysely.transaction().execute(async (trx) => {
      const revokedAt = iso(opts.now);
      const row = await trx
        .updateTable("browser_grants")
        .set({
          revoked_at: revokedAt,
          expires_reason: "manual",
        })
        .where("owner_id", "=", opts.ownerId)
        .where("id", "=", opts.grantId)
        .returningAll()
        .executeTakeFirst();
      if (!row) return null;
      await this.addAuditEventIn(trx, {
        id: id("audit"),
        ownerId: opts.ownerId,
        eventType: "permission.revoked",
        createdAt: revokedAt,
        metadata: { grantId: opts.grantId },
      });
      return toGrantRecord(row);
    });
  }

  async addAuditEvent(event: BrowserAuditEvent): Promise<void> {
    await this.addAuditEventIn(this.kysely, event);
  }

  async listAuditEvents(ownerId: string): Promise<BrowserAuditEvent[]> {
    const rows = await this.kysely
      .selectFrom("browser_audit_events")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(toAuditEvent);
  }

  async listAuditPage(opts: {
    ownerId: string;
    limit?: number;
    cursor?: string;
    eventType?: BrowserAuditEventType;
  }): Promise<BrowserAuditPage> {
    const limit = clampLimit(opts.limit);
    const cursorTime = opts.cursor ? Buffer.from(opts.cursor, "base64url").toString("utf8") : null;
    let query = this.kysely
      .selectFrom("browser_audit_events")
      .selectAll()
      .where("owner_id", "=", opts.ownerId)
      .orderBy("created_at", "desc")
      .limit(limit + 1);
    if (opts.eventType) {
      query = query.where("event_type", "=", opts.eventType);
    }
    if (cursorTime) {
      query = query.where("created_at", "<", cursorTime);
    }
    const rows = await query.execute();
    const page = rows.slice(0, limit).map(toAuditEvent);
    return {
      events: page,
      nextCursor: rows.length > limit ? encodeAuditCursor(page[page.length - 1]?.createdAt) : null,
    };
  }

  async pruneAuditEvents(opts: { ownerId: string; now?: number; retentionDays?: number }): Promise<number> {
    const cutoff = new Date(
      (opts.now ?? Date.now()) - (opts.retentionDays ?? 180) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await this.kysely
      .deleteFrom("browser_audit_events")
      .where("owner_id", "=", opts.ownerId)
      .where("created_at", "<", cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  private async upsertProfileIn(db: BrowserDb, ownerId: string, name: string, now = Date.now()): Promise<BrowserProfileRecord> {
    const timestamp = iso(now);
    const row = await db
      .insertInto("browser_profiles")
      .values({
        id: id("browser_profile"),
        owner_id: ownerId,
        name,
        cleared_scopes: jsonb([]),
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict((oc) => oc.columns(["owner_id", "name"]).doUpdateSet({ updated_at: timestamp }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProfileRecord(row);
  }

  private async addAuditEventIn(db: BrowserDb, event: BrowserAuditEvent): Promise<void> {
    const redacted = redactAuditEvent(event);
    await db
      .insertInto("browser_audit_events")
      .values({
        id: redacted.id,
        owner_id: redacted.ownerId,
        event_type: redacted.eventType,
        metadata: jsonb(redacted.metadata ?? {}),
        created_at: redacted.createdAt,
      })
      .execute();
  }
}

export function redactAuditEvent(event: BrowserAuditEvent): BrowserAuditEvent {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.metadata ?? {})) {
    const lower = key.toLowerCase();
    if (
      lower.includes("cookie") ||
      lower.includes("authorization") ||
      lower.includes("password") ||
      lower.includes("html") ||
      lower.includes("screenshot") ||
      lower.includes("path")
    ) {
      continue;
    }
    metadata[key] = typeof value === "string" && value.length > 512 ? `${value.slice(0, 512)}...` : value;
  }
  return { ...event, metadata };
}

function validateGrantDomains(domains: string[]): void {
  for (const domain of domains) {
    if (!SAFE_DOMAIN.test(domain)) {
      throw new BrowserRepositoryError("invalid_grant_domain");
    }
  }
}

function jsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toStringArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function toProfileRecord(row: Selectable<BrowserProfilesTable>): BrowserProfileRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    clearedScopes: toStringArray(row.cleared_scopes) as BrowserProfileClearScope[],
  };
}

function toSessionRecord(row: Selectable<BrowserSessionsTable>): BrowserSessionRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    profileId: row.profile_id,
    profileName: row.profile_name,
    state: row.state,
    currentTabId: row.current_tab_id,
    lockDeviceId: row.lock_device_id,
    takeoverRequired: Boolean(row.takeover_required),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
    lastActivityAt: toIso(row.last_activity_at) ?? new Date().toISOString(),
  };
}

function toGrantRecord(row: Selectable<BrowserGrantsTable>): BrowserGrantRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    scopes: toStringArray(row.scopes) as BrowserGrantScope[],
    domains: toStringArray(row.domains),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    expiresAt: toIso(row.expires_at) ?? new Date().toISOString(),
    revokedAt: toIso(row.revoked_at),
    expiresReason: row.expires_reason,
  };
}

function toTabRecord(row: Selectable<BrowserTabsTable>): BrowserTabRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    url: row.url,
    title: row.title,
    order: row.tab_order,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function toDownloadRecord(row: Selectable<BrowserDownloadsTable>): BrowserDownloadRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    filename: row.filename,
    state: row.state,
    stagedPath: row.staged_path,
    completedPath: row.completed_path,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date().toISOString(),
  };
}

function toAuditEvent(row: Selectable<BrowserAuditEventsTable>): BrowserAuditEvent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    eventType: row.event_type,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

function clampLimit(limit = 50): number {
  return Math.min(Math.max(limit, 1), 100);
}

function encodeAuditCursor(createdAt: string | undefined): string | null {
  if (!createdAt) return null;
  return Buffer.from(createdAt).toString("base64url");
}
