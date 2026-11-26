import { sql, type Kysely, type Selectable } from 'kysely';
import { z } from 'zod/v4';
import type { PlatformDatabase } from '../db.js';
import type { MetalHostsTable } from '../database/migrations/metal-hosts.js';

/**
 * Registry of Matrix-operated bare-metal hosts (spec 2691, ENG-520). Rows hold
 * routing and capacity facts only; host agent tokens come from platform config.
 * Every value is validated here, at the repository boundary, because the
 * routing layer builds upstream URLs from these rows.
 */

export const MetalHostStatusSchema = z.enum(['active', 'draining', 'down']);
export type MetalHostStatus = z.infer<typeof MetalHostStatusSchema>;

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const INGRESS = /^([^:]+)(?::([1-9]\d{0,4}))?$/;

function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => IPV4_OCTET.test(part));
}

/** A DNS hostname or a dotted IPv4 address. All-numeric names must be valid IPv4. */
function isHost(value: string): boolean {
  if (/^[\d.]+$/.test(value)) return isIPv4(value);
  return value.length <= 253 && value.split('.').every((label) => HOST_LABEL.test(label));
}

/** `host` or `host:port`: no scheme, credentials, path, query, or IPv6 literal. */
export const MetalIngressHostSchema = z.string().min(1).max(259).refine((value) => {
  const match = INGRESS.exec(value);
  if (!match) return false;
  if (match[2] !== undefined && Number(match[2]) > 65_535) return false;
  return isHost(match[1]!);
}, 'invalid ingress host').transform((value) => value.toLowerCase());

/** Plain `https://host[:port]` origin: no credentials, path, query, or fragment. Stored as the origin. */
export const MetalApiUrlSchema = z.string().min(1).max(512).refine((value) => {
  if (value.includes('?') || value.includes('#') || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:'
    && url.username === ''
    && url.password === ''
    && url.pathname === '/'
    && isHost(url.hostname);
}, 'invalid api url').transform((value) => new URL(value).origin);

const MetalHostIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const MetalHostNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
const MebibytesSchema = z.number().int().positive().max(2_147_483_647);

export const MetalHostInputSchema = z.object({
  id: MetalHostIdSchema,
  name: MetalHostNameSchema,
  apiUrl: MetalApiUrlSchema,
  ingressHost: MetalIngressHostSchema,
  status: MetalHostStatusSchema,
  memoryCapacityMib: MebibytesSchema,
  admissionCeilingMib: MebibytesSchema,
}).strict().refine(
  (host) => host.admissionCeilingMib <= host.memoryCapacityMib,
  'admission ceiling exceeds memory capacity',
);
export type MetalHostInput = z.input<typeof MetalHostInputSchema>;

export interface MetalHost {
  id: string;
  name: string;
  apiUrl: string;
  ingressHost: string;
  status: MetalHostStatus;
  memoryCapacityMib: number;
  admissionCeilingMib: number;
  createdAt: Date;
  updatedAt: Date;
}

export type MetalHostsRepositoryErrorCode = 'invalid_host' | 'name_conflict' | 'invalid_row' | 'unavailable';

const ERROR_MESSAGES: Record<MetalHostsRepositoryErrorCode, string> = {
  invalid_host: 'Metal host input is invalid',
  name_conflict: 'A metal host with this name already exists',
  invalid_row: 'Stored metal host record is invalid',
  unavailable: 'Metal host registry is unavailable',
};

export class MetalHostsRepositoryError extends Error {
  readonly code: MetalHostsRepositoryErrorCode;

  constructor(code: MetalHostsRepositoryErrorCode, options?: { cause?: unknown }) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'MetalHostsRepositoryError';
    this.code = code;
  }
}

export interface MetalHostsRepository {
  /** Hosts that may admit new VMs, ordered by name. */
  listActive(): Promise<MetalHost[]>;
  /** The host, or null when no host has this id. Database failures throw. */
  get(id: string): Promise<MetalHost | null>;
  /** Inserts the host, or updates every field of the host with the same id. */
  upsert(host: MetalHostInput): Promise<MetalHost>;
}

function isNameConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, constraint } = error as Error & { code?: unknown; constraint?: unknown };
  return code === '23505' && (constraint === 'metal_hosts_name_key' || error.message.includes('metal_hosts_name_key'));
}

function toRepositoryError(error: unknown): MetalHostsRepositoryError {
  if (error instanceof MetalHostsRepositoryError) return error;
  if (isNameConflict(error)) return new MetalHostsRepositoryError('name_conflict', { cause: error });
  console.error(
    '[metal-hosts] database operation failed:',
    error instanceof Error ? error.message.slice(0, 300) : 'unknown failure',
  );
  return new MetalHostsRepositoryError('unavailable', { cause: error });
}

const StoredRowSchema = z.object({
  id: MetalHostIdSchema,
  name: MetalHostNameSchema,
  api_url: MetalApiUrlSchema,
  ingress_host: MetalIngressHostSchema,
  status: MetalHostStatusSchema,
  memory_capacity_mib: MebibytesSchema,
  admission_ceiling_mib: MebibytesSchema,
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

function mapRow(row: Selectable<MetalHostsTable>): MetalHost {
  const parsed = StoredRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[metal-hosts] stored row failed validation:', row.id);
    throw new MetalHostsRepositoryError('invalid_row');
  }
  const r = parsed.data;
  return {
    id: r.id,
    name: r.name,
    apiUrl: r.api_url,
    ingressHost: r.ingress_host,
    status: r.status,
    memoryCapacityMib: r.memory_capacity_mib,
    admissionCeilingMib: r.admission_ceiling_mib,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createMetalHostsRepository(db: Kysely<PlatformDatabase>): MetalHostsRepository {
  return {
    async listActive() {
      let rows: Selectable<MetalHostsTable>[];
      try {
        rows = await db.selectFrom('metal_hosts').selectAll()
          .where('status', '=', 'active')
          .orderBy('name')
          .execute();
      } catch (error: unknown) {
        throw toRepositoryError(error);
      }
      return rows.map(mapRow);
    },

    async get(id) {
      const parsedId = MetalHostIdSchema.safeParse(id);
      if (!parsedId.success) throw new MetalHostsRepositoryError('invalid_host');
      let row: Selectable<MetalHostsTable> | undefined;
      try {
        row = await db.selectFrom('metal_hosts').selectAll()
          .where('id', '=', parsedId.data)
          .executeTakeFirst();
      } catch (error: unknown) {
        throw toRepositoryError(error);
      }
      return row ? mapRow(row) : null;
    },

    async upsert(input) {
      const parsed = MetalHostInputSchema.safeParse(input);
      if (!parsed.success) throw new MetalHostsRepositoryError('invalid_host');
      const host = parsed.data;
      let row: Selectable<MetalHostsTable>;
      try {
        row = await db.insertInto('metal_hosts')
          .values({
            id: host.id,
            name: host.name,
            api_url: host.apiUrl,
            ingress_host: host.ingressHost,
            status: host.status,
            memory_capacity_mib: host.memoryCapacityMib,
            admission_ceiling_mib: host.admissionCeilingMib,
          })
          .onConflict((oc) => oc.column('id').doUpdateSet({
            name: host.name,
            api_url: host.apiUrl,
            ingress_host: host.ingressHost,
            status: host.status,
            memory_capacity_mib: host.memoryCapacityMib,
            admission_ceiling_mib: host.admissionCeilingMib,
            updated_at: sql<Date>`now()`,
          }))
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error: unknown) {
        throw toRepositoryError(error);
      }
      return mapRow(row);
    },
  };
}
