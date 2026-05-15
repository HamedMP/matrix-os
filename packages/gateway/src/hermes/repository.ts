import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import {
  MAX_HERMES_APPROVALS,
  MAX_HERMES_CHANNELS,
  MAX_HERMES_EVENTS,
  MAX_HERMES_MODEL_PROVIDERS,
  MAX_HERMES_SESSIONS,
  defaultHermesInstallation,
  defaultSetupSteps,
  redactLabel,
  type ApprovalPrompt,
  type HermesConfigInput,
  type HermesInstallation,
  type HermesSession,
  type HermesSnapshot,
  type MessagingChannel,
  type ModelProviderConnection,
  type OperatorEvent,
} from "./contracts.js";

const MAX_IN_MEMORY_HERMES_SNAPSHOTS = 200;

export interface HermesRepository {
  bootstrap(): Promise<void>;
  resolveOwnerIdForOperator(principalUserId: string): Promise<string | null>;
  getSnapshot(ownerId: string): Promise<HermesSnapshot>;
  saveConfig(ownerId: string, input: HermesConfigInput, actorId: string, patch?: Partial<HermesInstallation>): Promise<HermesInstallation>;
  applyInstallationPatch(ownerId: string, patch: Partial<HermesInstallation>): Promise<HermesInstallation | null>;
  setModelCredentialConfigured(ownerId: string, provider: ModelProviderConnection, actorId: string): Promise<ModelProviderConnection>;
  upsertChannel(ownerId: string, channel: MessagingChannel, actorId?: string): Promise<MessagingChannel>;
  upsertSession(ownerId: string, session: HermesSession): Promise<HermesSession>;
  getSession(ownerId: string, sessionId: string): Promise<HermesSession | null>;
  upsertApproval(ownerId: string, approval: ApprovalPrompt): Promise<ApprovalPrompt>;
  getApproval(ownerId: string, approvalId: string): Promise<ApprovalPrompt | null>;
  appendEvent(ownerId: string, event: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<OperatorEvent>;
  replaceSnapshot(ownerId: string, snapshot: HermesSnapshot): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptySnapshot(): HermesSnapshot {
  return {
    installation: null,
    setupSteps: defaultSetupSteps(),
    modelProviders: [],
    channels: [],
    sessions: [],
    approvals: [],
    capabilities: [],
    events: [],
  };
}

function rowJson<T>(row: Record<string, unknown>, key: string): T {
  const value = row[key];
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function applyEvent(snapshot: HermesSnapshot, input: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): OperatorEvent {
  const event: OperatorEvent = {
    id: input.id ?? `evt_${randomUUID()}`,
    createdAt: input.createdAt ?? nowIso(),
    ...input,
  };
  snapshot.events = [...snapshot.events, event].slice(-MAX_HERMES_EVENTS);
  return event;
}

function upsertById<T extends { id: string }>(items: T[], item: T, max = Number.POSITIVE_INFINITY): T[] {
  const without = items.filter((entry) => entry.id !== item.id);
  return [...without, item].slice(-max);
}

function publicInstallation(ownerId: string, input: HermesConfigInput, existing: HermesInstallation | null, patch: Partial<HermesInstallation> = {}): HermesInstallation {
  const timestamp = nowIso();
  const base = existing ?? defaultHermesInstallation(ownerId);
  const homeMode = patch.homeMode ?? input.homeMode ?? base.homeMode;
  const defaultProfileId = input.defaultProfileId ?? base.defaultProfileId;
  const defaultModelId = input.defaultModelId ?? base.defaultModelId;
  const authorizedOperators = input.authorizedOperators ?? base.authorizedOperators;
  const hermesPathLabel = patch.hermesPathLabel !== undefined
    ? patch.hermesPathLabel
    : input.hermesPath ? redactLabel(input.hermesPath) : base.hermesPathLabel;
  return {
    ...base,
    ...patch,
    homeMode,
    hermesPathLabel,
    defaultProfileId,
    defaultModelId,
    authorizedOperators,
    readiness: patch.readiness ?? (base.readiness === "missing" ? "installed" : base.readiness),
    gatewayStatus: patch.gatewayStatus ?? base.gatewayStatus,
    ownerId,
    id: base.id,
    createdAt: base.createdAt,
    updatedAt: timestamp,
  };
}

function applyInstallationPatchToExisting(existing: HermesInstallation, patch: Partial<HermesInstallation>): HermesInstallation {
  const readiness = patch.readiness === "installed" && existing.readiness !== "missing"
    ? existing.readiness
    : patch.readiness ?? existing.readiness;
  return { ...existing, ...patch, readiness, updatedAt: nowIso() };
}

export class InMemoryHermesRepository implements HermesRepository {
  private readonly snapshots = new Map<string, HermesSnapshot>();

  async bootstrap(): Promise<void> {}

  private rememberSnapshot(ownerId: string, snapshot: HermesSnapshot): void {
    this.snapshots.delete(ownerId);
    this.snapshots.set(ownerId, structuredClone(snapshot));
    while (this.snapshots.size > MAX_IN_MEMORY_HERMES_SNAPSHOTS) {
      const oldestOwnerId = this.snapshots.keys().next().value as string | undefined;
      if (!oldestOwnerId) break;
      this.snapshots.delete(oldestOwnerId);
    }
  }

  async resolveOwnerIdForOperator(principalUserId: string): Promise<string | null> {
    const direct = this.snapshots.get(principalUserId);
    if (direct?.installation) return principalUserId;
    const matches = [...this.snapshots.entries()]
      .filter(([, snapshot]) => snapshot.installation?.authorizedOperators.includes(principalUserId))
      .sort(([leftOwnerId, leftSnapshot], [rightOwnerId, rightSnapshot]) => {
        const rightUpdatedAt = rightSnapshot.installation?.updatedAt ?? "";
        const leftUpdatedAt = leftSnapshot.installation?.updatedAt ?? "";
        return rightUpdatedAt.localeCompare(leftUpdatedAt) || leftOwnerId.localeCompare(rightOwnerId);
      });
    return matches[0]?.[0] ?? null;
  }

  async getSnapshot(ownerId: string): Promise<HermesSnapshot> {
    const snapshot = this.snapshots.get(ownerId);
    if (!snapshot) return structuredClone(emptySnapshot());
    this.rememberSnapshot(ownerId, snapshot);
    return structuredClone(snapshot);
  }

  async replaceSnapshot(ownerId: string, snapshot: HermesSnapshot): Promise<void> {
    this.rememberSnapshot(ownerId, snapshot);
  }

  async saveConfig(ownerId: string, input: HermesConfigInput, _actorId: string, patch: Partial<HermesInstallation> = {}): Promise<HermesInstallation> {
    const snapshot = await this.getSnapshot(ownerId);
    const installation = publicInstallation(ownerId, input, snapshot.installation, patch);
    snapshot.installation = installation;
    snapshot.setupSteps = (snapshot.setupSteps.length ? snapshot.setupSteps : defaultSetupSteps())
      .map((step) => step.id === "installation" ? { ...step, status: "complete", detail: "Hermes installation configured" } : step);
    await this.replaceSnapshot(ownerId, snapshot);
    return installation;
  }

  async applyInstallationPatch(ownerId: string, patch: Partial<HermesInstallation>): Promise<HermesInstallation | null> {
    const snapshot = await this.getSnapshot(ownerId);
    if (!snapshot.installation) return null;
    snapshot.installation = applyInstallationPatchToExisting(snapshot.installation, patch);
    await this.replaceSnapshot(ownerId, snapshot);
    return snapshot.installation;
  }

  async setModelCredentialConfigured(ownerId: string, provider: ModelProviderConnection, _actorId: string): Promise<ModelProviderConnection> {
    const snapshot = await this.getSnapshot(ownerId);
    snapshot.modelProviders = upsertById(snapshot.modelProviders, provider, MAX_HERMES_MODEL_PROVIDERS);
    if (snapshot.installation) {
      snapshot.setupSteps = snapshot.setupSteps.map((step) => step.id === "model" ? { ...step, status: provider.configured ? "complete" : "pending", detail: provider.configured ? "Model provider configured" : "Model provider needs setup" } : step);
    }
    await this.replaceSnapshot(ownerId, snapshot);
    return provider;
  }

  async upsertChannel(ownerId: string, channel: MessagingChannel, actorId?: string): Promise<MessagingChannel> {
    const snapshot = await this.getSnapshot(ownerId);
    snapshot.channels = upsertById(snapshot.channels, channel, MAX_HERMES_CHANNELS);
    snapshot.setupSteps = snapshot.setupSteps.map((step) => step.id === "channel" ? { ...step, status: snapshot.channels.some((item) => item.status === "connected") ? "complete" : "pending", detail: "Messaging channel updated" } : step);
    applyEvent(snapshot, { installationId: snapshot.installation?.id ?? `hermes_${ownerId}`, actorId, category: "channel", severity: "info", message: "Channel updated", targetId: channel.id });
    await this.replaceSnapshot(ownerId, snapshot);
    return channel;
  }

  async upsertSession(ownerId: string, session: HermesSession): Promise<HermesSession> {
    const snapshot = await this.getSnapshot(ownerId);
    snapshot.sessions = upsertById(snapshot.sessions, session, MAX_HERMES_SESSIONS);
    await this.replaceSnapshot(ownerId, snapshot);
    return session;
  }

  async getSession(ownerId: string, sessionId: string): Promise<HermesSession | null> {
    return (await this.getSnapshot(ownerId)).sessions.find((session) => session.id === sessionId) ?? null;
  }

  async upsertApproval(ownerId: string, approval: ApprovalPrompt): Promise<ApprovalPrompt> {
    const snapshot = await this.getSnapshot(ownerId);
    snapshot.approvals = upsertById(snapshot.approvals, approval, MAX_HERMES_APPROVALS);
    await this.replaceSnapshot(ownerId, snapshot);
    return approval;
  }

  async getApproval(ownerId: string, approvalId: string): Promise<ApprovalPrompt | null> {
    return (await this.getSnapshot(ownerId)).approvals.find((approval) => approval.id === approvalId) ?? null;
  }

  async appendEvent(ownerId: string, input: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<OperatorEvent> {
    const snapshot = await this.getSnapshot(ownerId);
    const event = applyEvent(snapshot, input);
    await this.replaceSnapshot(ownerId, snapshot);
    return event;
  }
}

export class KyselyHermesRepository extends InMemoryHermesRepository {
  constructor(private readonly db: Kysely<any>) {
    super();
  }

  async bootstrap(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS matrix_hermes_manager_state (
        owner_id text PRIMARY KEY,
        snapshot jsonb NOT NULL,
        updated_at timestamptz DEFAULT now()
      )
    `.execute(this.db);
  }

  override async getSnapshot(ownerId: string): Promise<HermesSnapshot> {
    const row = await this.db
      .selectFrom("matrix_hermes_manager_state")
      .select(["snapshot"])
      .where("owner_id", "=", ownerId)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    if (!row) return emptySnapshot();
    return rowJson<HermesSnapshot>(row, "snapshot");
  }

  private async writeSnapshot(executor: Kysely<any>, ownerId: string, snapshot: HermesSnapshot): Promise<void> {
    await executor
      .insertInto("matrix_hermes_manager_state")
      .values({ owner_id: ownerId, snapshot: JSON.stringify(snapshot) })
      .onConflict((oc) => oc.column("owner_id").doUpdateSet({ snapshot: JSON.stringify(snapshot), updated_at: sql`now()` }))
      .execute();
  }

  override async replaceSnapshot(ownerId: string, snapshot: HermesSnapshot): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(trx);
      await this.writeSnapshot(trx as unknown as Kysely<any>, ownerId, snapshot);
    });
  }

  // Production mutators hold one owner-scoped Postgres advisory lock while reading and writing the JSONB snapshot.
  private async mutateSnapshot<T>(ownerId: string, fn: (snapshot: HermesSnapshot) => T): Promise<T> {
    return await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(trx);
      const row = await trx
        .selectFrom("matrix_hermes_manager_state")
        .select(["snapshot"])
        .where("owner_id", "=", ownerId)
        .executeTakeFirst() as Record<string, unknown> | undefined;
      const snapshot = row ? rowJson<HermesSnapshot>(row, "snapshot") : emptySnapshot();
      const result = fn(snapshot);
      await this.writeSnapshot(trx as unknown as Kysely<any>, ownerId, snapshot);
      return result;
    });
  }

  override async saveConfig(ownerId: string, input: HermesConfigInput, _actorId: string, patch: Partial<HermesInstallation> = {}): Promise<HermesInstallation> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      const installation = publicInstallation(ownerId, input, snapshot.installation, patch);
      snapshot.installation = installation;
      snapshot.setupSteps = (snapshot.setupSteps.length ? snapshot.setupSteps : defaultSetupSteps())
        .map((step) => step.id === "installation" ? { ...step, status: "complete", detail: "Hermes installation configured" } : step);
      return installation;
    });
  }

  override async applyInstallationPatch(ownerId: string, patch: Partial<HermesInstallation>): Promise<HermesInstallation | null> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      if (!snapshot.installation) return null;
      snapshot.installation = applyInstallationPatchToExisting(snapshot.installation, patch);
      return snapshot.installation;
    });
  }

  override async setModelCredentialConfigured(ownerId: string, provider: ModelProviderConnection, _actorId: string): Promise<ModelProviderConnection> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      snapshot.modelProviders = upsertById(snapshot.modelProviders, provider, MAX_HERMES_MODEL_PROVIDERS);
      if (snapshot.installation) {
        snapshot.setupSteps = snapshot.setupSteps.map((step) => step.id === "model" ? { ...step, status: provider.configured ? "complete" : "pending", detail: provider.configured ? "Model provider configured" : "Model provider needs setup" } : step);
      }
      return provider;
    });
  }

  override async upsertChannel(ownerId: string, channel: MessagingChannel, actorId?: string): Promise<MessagingChannel> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      snapshot.channels = upsertById(snapshot.channels, channel, MAX_HERMES_CHANNELS);
      snapshot.setupSteps = snapshot.setupSteps.map((step) => step.id === "channel" ? { ...step, status: snapshot.channels.some((item) => item.status === "connected") ? "complete" : "pending", detail: "Messaging channel updated" } : step);
      applyEvent(snapshot, { installationId: snapshot.installation?.id ?? `hermes_${ownerId}`, actorId, category: "channel", severity: "info", message: "Channel updated", targetId: channel.id });
      return channel;
    });
  }

  override async upsertSession(ownerId: string, session: HermesSession): Promise<HermesSession> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      snapshot.sessions = upsertById(snapshot.sessions, session, MAX_HERMES_SESSIONS);
      return session;
    });
  }

  override async upsertApproval(ownerId: string, approval: ApprovalPrompt): Promise<ApprovalPrompt> {
    return await this.mutateSnapshot(ownerId, (snapshot) => {
      snapshot.approvals = upsertById(snapshot.approvals, approval, MAX_HERMES_APPROVALS);
      return approval;
    });
  }

  override async appendEvent(ownerId: string, input: Omit<OperatorEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): Promise<OperatorEvent> {
    return await this.mutateSnapshot(ownerId, (snapshot) => applyEvent(snapshot, input));
  }

  override async resolveOwnerIdForOperator(principalUserId: string): Promise<string | null> {
    const direct = await this.db
      .selectFrom("matrix_hermes_manager_state")
      .select(["owner_id", "snapshot"])
      .where("owner_id", "=", principalUserId)
      .executeTakeFirst() as Record<string, unknown> | undefined;
    if (direct && rowJson<HermesSnapshot>(direct, "snapshot").installation) return principalUserId;
    const delegated = await this.db
      .selectFrom("matrix_hermes_manager_state")
      .select(["owner_id", "snapshot"])
      .where(sql<boolean>`snapshot->'installation'->'authorizedOperators' ? ${principalUserId}`)
      .orderBy("updated_at", "desc")
      .orderBy("owner_id", "asc")
      .executeTakeFirst() as Record<string, unknown> | undefined;
    return delegated ? String(delegated.owner_id) : null;
  }
}
