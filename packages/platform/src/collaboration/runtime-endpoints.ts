/**
 * Runtime endpoint directory (S05 / T026).
 *
 * Every enrolled customer VPS registers itself as a relay-routable home by
 * its existing enrollment identity. The platform stores metadata only: the
 * logical runtime id (`vps-<uuid>`, never a hostname), the owner, the relay
 * handle the existing session routing already knows, the authority
 * generation, the home's asymmetric public keys and an optional future
 * direct origin that is validated but never fetched in this release. No
 * caller-supplied address is ever stored or dialled from here.
 */
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationRuntimeEndpointRegistrationSchema,
  type CollaborationRuntimeEndpointRegistration,
} from "@matrix-os/contracts";
import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import { runPlatformMigration } from "../migration-runner.js";
import { logicalRuntimeIdFor } from "./runtime-identity.js";

type Timestamp = ColumnType<Date | string, Date | string | undefined, Date | string>;

export interface CollaborationRuntimeEndpointsTable {
  runtime_id: string;
  owner_id: string;
  relay_handle: string;
  authority_generation: number | string;
  protocol_version: number;
  public_keys: unknown;
  future_direct_origin: string | null;
  registered_at: Timestamp;
  last_seen_at: Timestamp;
  updated_at: Timestamp;
}

export interface RuntimeEndpointPlatformDatabase {
  collaboration_runtime_endpoints: CollaborationRuntimeEndpointsTable;
}

export interface RuntimeEndpointPublicKey {
  keyId: string;
  algorithm: "ed25519";
  publicKey: string;
  /** Set once a later registration omitted the key; kept for the overlap window only. */
  retiredAt?: string;
}

export interface RuntimeEndpointRecord {
  runtimeId: string;
  ownerId: string;
  relayHandle: string;
  authorityGeneration: number;
  protocolVersion: number;
  publicKeys: RuntimeEndpointPublicKey[];
  futureDirectOrigin?: string;
  registeredAt: string;
  lastSeenAt: string;
}

export type CollaborationRuntimeEndpointErrorCode =
  | "invalid_registration"
  | "upgrade_required"
  | "runtime_mismatch"
  | "owner_mismatch"
  | "relay_handle_mismatch"
  | "stale_generation"
  | "direct_origin_rejected";

export class CollaborationRuntimeEndpointError extends Error {
  constructor(public readonly code: CollaborationRuntimeEndpointErrorCode, message: string) {
    super(message);
    this.name = "CollaborationRuntimeEndpointError";
  }
}

const DEFAULT_KEY_OVERLAP_MS = 10 * 60_000;
const MAX_STORED_KEYS = 16;
const RESERVED_ORIGIN_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".home", ".lan", ".corp", ".arpa", ".test", ".invalid", ".example", ".onion"];
const RESERVED_ORIGIN_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

/** Bootstraps inside the platform's locked schema migration transaction (S20 layer 4 pattern). */
export async function bootstrapPlatformRuntimeEndpointDatabase(
  db: Kysely<RuntimeEndpointPlatformDatabase>,
): Promise<void> {
  await runPlatformMigration(db, (trx) => applyRuntimeEndpointSchema(trx));
}

async function applyRuntimeEndpointSchema(db: Transaction<RuntimeEndpointPlatformDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS collaboration_runtime_endpoints (
      runtime_id TEXT PRIMARY KEY CHECK (char_length(runtime_id) BETWEEN 1 AND 128),
      owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
      relay_handle TEXT NOT NULL CHECK (char_length(relay_handle) BETWEEN 1 AND 160),
      authority_generation BIGINT NOT NULL CHECK (authority_generation > 0),
      protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
      public_keys JSONB NOT NULL,
      future_direct_origin TEXT CHECK (future_direct_origin IS NULL OR char_length(future_direct_origin) <= 267),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_collaboration_runtime_endpoints_owner
      ON collaboration_runtime_endpoints(owner_id)
  `.execute(db);
}

export class CollaborationRuntimeEndpointRegistry {
  private readonly now: () => Date;
  private readonly keyOverlapMs: number;

  constructor(
    private readonly db: Kysely<RuntimeEndpointPlatformDatabase>,
    options: { now?: () => Date; keyOverlapMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.keyOverlapMs = options.keyOverlapMs ?? DEFAULT_KEY_OVERLAP_MS;
  }

  /**
   * Registers or refreshes a home. The authenticated enrollment identity is
   * authoritative: the registration must name the logical form of that
   * runtime id, the same owner and the same relay handle, or nothing is
   * written.
   */
  async register(input: {
    authenticated: { runtimeId: string; ownerId: string; relayHandle: string };
    registration: unknown;
  }): Promise<RuntimeEndpointRecord> {
    const parsed = parseRegistration(input.registration);
    const logical = logicalRuntimeIdFor(input.authenticated.runtimeId);
    if (!logical || parsed.runtimeId !== logical) {
      throw new CollaborationRuntimeEndpointError("runtime_mismatch", "Registration runtime does not match the enrolled runtime");
    }
    if (parsed.ownerId !== input.authenticated.ownerId) {
      throw new CollaborationRuntimeEndpointError("owner_mismatch", "Registration owner does not match the enrolled owner");
    }
    if (parsed.relayHandle !== input.authenticated.relayHandle) {
      throw new CollaborationRuntimeEndpointError("relay_handle_mismatch", "Registration relay handle does not match enrollment");
    }
    if (parsed.futureDirectOrigin !== undefined && !isPublicHttpsOrigin(parsed.futureDirectOrigin)) {
      throw new CollaborationRuntimeEndpointError("direct_origin_rejected", "Direct origin must be a public https hostname");
    }
    const current = this.now();
    const existing = await this.db.selectFrom("collaboration_runtime_endpoints")
      .selectAll().where("runtime_id", "=", logical).executeTakeFirst();
    if (existing && Number(existing.authority_generation) > parsed.authorityGeneration) {
      throw new CollaborationRuntimeEndpointError("stale_generation", "Registration generation is older than the recorded generation");
    }
    const publicKeys = mergeKeys(existing ? parseStoredKeys(existing.public_keys) : [], parsed.publicKeys, current, this.keyOverlapMs);
    const row = {
      runtime_id: logical,
      owner_id: parsed.ownerId,
      relay_handle: parsed.relayHandle,
      authority_generation: parsed.authorityGeneration,
      protocol_version: parsed.protocolVersion,
      public_keys: JSON.stringify(publicKeys),
      future_direct_origin: parsed.futureDirectOrigin ?? null,
      last_seen_at: current,
      updated_at: current,
    };
    await this.db.insertInto("collaboration_runtime_endpoints")
      .values({ ...row, registered_at: current })
      .onConflict((oc) => oc.column("runtime_id").doUpdateSet(row)
        .where("collaboration_runtime_endpoints.authority_generation", "<=", parsed.authorityGeneration))
      .execute();
    const stored = await this.resolve(logical);
    if (!stored || stored.authorityGeneration !== parsed.authorityGeneration) {
      throw new CollaborationRuntimeEndpointError("stale_generation", "Registration generation is older than the recorded generation");
    }
    return stored;
  }

  async resolve(logicalRuntimeId: string): Promise<RuntimeEndpointRecord | null> {
    const row = await this.db.selectFrom("collaboration_runtime_endpoints")
      .selectAll().where("runtime_id", "=", logicalRuntimeId).executeTakeFirst();
    if (!row) return null;
    return {
      runtimeId: row.runtime_id,
      ownerId: row.owner_id,
      relayHandle: row.relay_handle,
      authorityGeneration: Number(row.authority_generation),
      protocolVersion: row.protocol_version,
      publicKeys: parseStoredKeys(row.public_keys),
      ...(row.future_direct_origin ? { futureDirectOrigin: row.future_direct_origin } : {}),
      registeredAt: new Date(row.registered_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
    };
  }

  /** Resolves by the enrollment form (`vps:<uuid>`) the directory still records. */
  async resolveEnrolled(runtimeId: string): Promise<RuntimeEndpointRecord | null> {
    const logical = logicalRuntimeIdFor(runtimeId);
    return logical ? this.resolve(logical) : null;
  }

  async heartbeat(logicalRuntimeId: string): Promise<void> {
    await this.db.updateTable("collaboration_runtime_endpoints")
      .set({ last_seen_at: this.now() })
      .where("runtime_id", "=", logicalRuntimeId)
      .execute();
  }

  /** Live (non-retired) verification keys for one home. */
  async liveKeys(logicalRuntimeId: string): Promise<RuntimeEndpointPublicKey[]> {
    const record = await this.resolve(logicalRuntimeId);
    return record ? record.publicKeys.filter((key) => key.retiredAt === undefined) : [];
  }
}

function parseRegistration(value: unknown): CollaborationRuntimeEndpointRegistration {
  const version = (value as { protocolVersion?: unknown } | null)?.protocolVersion;
  if (typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION) {
    throw new CollaborationRuntimeEndpointError("upgrade_required", "Registration protocol version is not supported");
  }
  const parsed = CollaborationRuntimeEndpointRegistrationSchema.safeParse(value);
  if (!parsed.success) throw new CollaborationRuntimeEndpointError("invalid_registration", "Registration is invalid");
  return parsed.data;
}

function parseStoredKeys(value: unknown): RuntimeEndpointPublicKey[] {
  const raw = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is RuntimeEndpointPublicKey => Boolean(entry)
    && typeof (entry as RuntimeEndpointPublicKey).keyId === "string"
    && typeof (entry as RuntimeEndpointPublicKey).publicKey === "string");
}

function mergeKeys(
  stored: RuntimeEndpointPublicKey[],
  presented: readonly { keyId: string; algorithm: "ed25519"; publicKey: string }[],
  now: Date,
  overlapMs: number,
): RuntimeEndpointPublicKey[] {
  const live = presented.map((key) => ({ keyId: key.keyId, algorithm: key.algorithm, publicKey: key.publicKey }));
  const presentedIds = new Set(live.map((key) => key.keyId));
  const retired = stored
    .filter((key) => !presentedIds.has(key.keyId))
    .map((key) => ({ ...key, retiredAt: key.retiredAt ?? now.toISOString() }))
    .filter((key) => now.getTime() - Date.parse(key.retiredAt!) < overlapMs);
  return [...live, ...retired].slice(0, MAX_STORED_KEYS);
}

/** Public https origin: no IP literals, no reserved or internal-looking names; never resolved here. */
export function isPublicHttpsOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[runtime-endpoints] origin parse failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin) return false;
  const host = parsed.hostname.toLowerCase();
  if (RESERVED_ORIGIN_HOSTS.has(host) || host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !host.includes(".")) return false;
  return !RESERVED_ORIGIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
