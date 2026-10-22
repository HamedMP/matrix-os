import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { z } from 'zod/v4';
import { FUNDED_AI_AUDIENCE, FUNDED_AI_SCOPE, FundedAiIdentitySchema, FundedAiRequestClassSchema,
  GoogleQualifiedFundedBindingSchema, GoogleQualifiedFundedCheckRequestSchema,
  MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, serializeManagedGoogleRouteDescriptor,
  type GoogleQualifiedFundedBinding } from '@matrix-os/contracts';
import type { PlatformDB, PlatformDatabase } from './db.js';

type Executor = PlatformDB['executor'];
type Identity = z.infer<typeof FundedAiIdentitySchema>;
type Clock = () => Date;
const tokenId = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Insert = z.strictObject({ identity: FundedAiIdentitySchema, tokenId, binding: GoogleQualifiedFundedBindingSchema });
const Query = z.strictObject({ identity: FundedAiIdentitySchema, tokenId,
  api: GoogleQualifiedFundedCheckRequestSchema.options[0].shape.api,
  canonicalModelId: GoogleQualifiedFundedCheckRequestSchema.options[0].shape.canonicalModelId,
  requestClass: FundedAiRequestClassSchema, expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export class GoogleQualifiedFundedRouteError extends Error {
  constructor() { super('Qualified AI route unavailable'); this.name = 'GoogleQualifiedFundedRouteError'; }
}
const deny = (): never => { throw new GoogleQualifiedFundedRouteError(); };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : deny();
}
/** Exact same pure canonical encoding/domain as the proxy; no package-to-package proxy import. */
export function googleQualifiedRouteDigest(descriptor: unknown): string {
  return createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN)
    .update(serializeManagedGoogleRouteDescriptor(descriptor)).digest('hex');
}
/** Explicit additive installer only. This unit does not install startup/runtime behavior. */
export async function installAiFundedRouteBindingSchema(executor: Executor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS ai_runtime_credential_routes (
    token_id TEXT PRIMARY KEY REFERENCES ai_runtime_credentials(token_id) ON UPDATE CASCADE ON DELETE CASCADE,
    descriptor JSONB NOT NULL CHECK (jsonb_typeof(descriptor) = 'object' AND octet_length(descriptor::text) <= 65536),
    descriptor_digest TEXT NOT NULL CHECK (descriptor_digest ~ '^[a-f0-9]{64}$'),
    relay_base_url TEXT NOT NULL CHECK (length(relay_base_url) BETWEEN 1 AND 2048),
    api TEXT NOT NULL CHECK (api = 'openai-completions'),
    canonical_model_id TEXT NOT NULL CHECK (length(canonical_model_id) BETWEEN 1 AND 160),
    request_class TEXT NOT NULL CHECK (request_class IN ('interactive', 'background')),
    evidence_expires_at TEXT NOT NULL,
    CHECK (api = descriptor #>> '{relay,api}'),
    CHECK (canonical_model_id = descriptor #>> '{upstream,canonicalModelId}'),
    CHECK (relay_base_url || '/v1/chat/completions' = descriptor #>> '{relay,endpoint}'),
    CHECK (evidence_expires_at = descriptor #>> '{evidence,expiresAt}')
  )`.execute(executor);
}
interface Credential {
  token_id: string; owner_id: string; machine_id: string; runtime_slot: string;
  audience: string; scope: string; issued_at: string; expires_at: string; revoked_at: string | null; request_class: string;
  clerk_user_id: string; machine_runtime_slot: string; status: string; activation_state: string; deleted_at: string | null;
}
interface StoredRoute {
  descriptor: unknown; descriptor_digest: string; relay_base_url: string; api: string;
  canonical_model_id: string; request_class: string; evidence_expires_at: string;
}
function validate(credential: Credential | undefined, identity: Identity, binding: GoogleQualifiedFundedBinding, clock: Clock): void {
  const at = clock().getTime(); const issued = Date.parse(credential?.issued_at ?? ''); const expires = Date.parse(credential?.expires_at ?? '');
  if (!credential || !Number.isSafeInteger(at) || !Number.isFinite(issued) || !Number.isFinite(expires)
    || credential.owner_id !== identity.ownerId || credential.machine_id !== identity.machineId || credential.runtime_slot !== identity.runtimeSlot
    || credential.clerk_user_id !== identity.ownerId || credential.machine_runtime_slot !== identity.runtimeSlot
    || credential.status !== 'running' || credential.activation_state !== 'authorized' || credential.deleted_at !== null
    || credential.revoked_at !== null || credential.audience !== FUNDED_AI_AUDIENCE || credential.scope !== FUNDED_AI_SCOPE
    || credential.request_class !== binding.requestClass || issued > at || expires <= at || expires <= issued || expires - issued > 60 * 60_000
    || expires > Date.parse(binding.evidenceExpiresAt) || at < Date.parse(binding.descriptor.evidence.reviewedAt)
    || issued < Date.parse(binding.descriptor.evidence.reviewedAt) || at >= Date.parse(binding.evidenceExpiresAt)
    || Buffer.byteLength(JSON.stringify(binding.descriptor)) > 65536 || googleQualifiedRouteDigest(binding.descriptor) !== binding.digest) deny();
}
const credentialColumns = sql`credential.token_id, credential.owner_id, credential.machine_id, credential.runtime_slot,
  credential.audience, credential.scope, credential.issued_at, credential.expires_at, credential.revoked_at, credential.request_class,
  machine.clerk_user_id, machine.runtime_slot AS machine_runtime_slot, machine.status, machine.activation_state, machine.deleted_at`;
function fromRow(row: StoredRoute): GoogleQualifiedFundedBinding {
  return parse(GoogleQualifiedFundedBindingSchema, { descriptor: row.descriptor, digest: row.descriptor_digest,
    relayBaseUrl: row.relay_base_url, api: row.api, canonicalModelId: row.canonical_model_id,
    requestClass: row.request_class, evidenceExpiresAt: row.evidence_expires_at });
}
/** pg_settings reports normalized integer milliseconds for both settings, regardless of input units.
 * Tighten only this caller-owned transaction; preserve stricter nonzero limits, and fail closed if unsupported. */
async function boundInsertStatements(trx: Transaction<PlatformDatabase>): Promise<void> {
  const applied = await sql<{ name: string }>`
    WITH limits(name, cap) AS (VALUES ('statement_timeout', 5000), ('lock_timeout', 2000))
    SELECT current.name, set_config(current.name,
      (CASE WHEN current.setting::bigint = 0 THEN limits.cap
        ELSE LEAST(current.setting::bigint, limits.cap) END)::text || 'ms', true)
    FROM pg_settings current JOIN limits ON limits.name = current.name
    WHERE current.unit = 'ms' AND current.vartype = 'integer' AND current.setting ~ '^[0-9]+$'
  `.execute(trx);
  if (applied.rows.length !== 2) deny();
}

/** Input route must come from authenticated control resolution; typing/child presence is NOT approval.
 * Caller owns transaction, authentication, policy/consent checks, deletion admission and final live checks.
 * This function never opens/commits/closes a transaction or mutates an existing token/route. */
export async function insertAiFundedRouteBinding(trx: Transaction<PlatformDatabase>, input: {
  identity: Identity; tokenId: string; binding: GoogleQualifiedFundedBinding;
}, clock: Clock = () => new Date()): Promise<GoogleQualifiedFundedBinding> {
  if (trx.isTransaction !== true) deny();
  const value = parse(Insert, input);
  await boundInsertStatements(trx);
  const credential = (await sql<Credential>`SELECT ${credentialColumns} FROM ai_runtime_credentials credential
    JOIN user_machines machine ON machine.machine_id = credential.machine_id
    WHERE credential.token_id = ${value.tokenId} FOR UPDATE OF credential`.execute(trx)).rows[0];
  validate(credential, value.identity, value.binding, clock);
  const encoded = serializeManagedGoogleRouteDescriptor(value.binding.descriptor);
  await sql`INSERT INTO ai_runtime_credential_routes (token_id, descriptor, descriptor_digest, relay_base_url, api,
    canonical_model_id, request_class, evidence_expires_at) VALUES (${value.tokenId}, ${encoded}::jsonb, ${value.binding.digest},
    ${value.binding.relayBaseUrl}, ${value.binding.api}, ${value.binding.canonicalModelId}, ${value.binding.requestClass}, ${value.binding.evidenceExpiresAt})
    ON CONFLICT (token_id) DO NOTHING`.execute(trx);
  const stored = (await sql<StoredRoute>`SELECT * FROM ai_runtime_credential_routes WHERE token_id = ${value.tokenId}`.execute(trx)).rows[0];
  if (!stored) deny();
  const actual = fromRow(stored);
  if (JSON.stringify(actual) !== JSON.stringify(value.binding)) deny();
  validate(credential, value.identity, actual, clock);
  return actual;
}

/** Absent child alone returns null. Existing-but-mismatched/expired/revoked facts are explicit denial.
 * This is a current read snapshot, not a live egress grant; callers revalidate at actual sends/releases. */
export async function readAiFundedRouteBinding(executor: Executor, input: z.infer<typeof Query>, clock: Clock = () => new Date()): Promise<GoogleQualifiedFundedBinding | null> {
  const value = parse(Query, input);
  const row = (await sql<Credential & StoredRoute>`SELECT ${credentialColumns}, route.descriptor, route.descriptor_digest,
    route.relay_base_url, route.api, route.canonical_model_id, route.request_class AS route_request_class, route.evidence_expires_at
    FROM ai_runtime_credential_routes route JOIN ai_runtime_credentials credential ON credential.token_id = route.token_id
    JOIN user_machines machine ON machine.machine_id = credential.machine_id
    WHERE route.token_id = ${value.tokenId}`.execute(executor)).rows[0] as (Credential & StoredRoute & { route_request_class: string }) | undefined;
  if (!row) return null;
  const actual = fromRow({ ...row, request_class: row.route_request_class });
  if (actual.api !== value.api || actual.canonicalModelId !== value.canonicalModelId || actual.requestClass !== value.requestClass
    || actual.digest !== value.expectedDigest) deny();
  validate(row, value.identity, actual, clock);
  return actual;
}
