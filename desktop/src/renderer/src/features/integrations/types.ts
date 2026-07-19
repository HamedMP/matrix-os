// Types and tolerant parsers for the gateway integration proxy routes
// (/api/integrations* — packages/gateway/src/integrations/routes.ts, either
// served directly by the gateway or proxied to the platform). The renderer
// only ever handles display-safe fields: no tokens, no scopes beyond counts,
// no provider error text. Remote logo URLs are deliberately dropped — the
// desktop renders icon initials instead of remote images.

export const MAX_AVAILABLE_INTEGRATIONS = 200;
export const MAX_CONNECTED_INTEGRATIONS = 200;

export interface AvailableIntegration {
  id: string;
  name: string;
  category: string;
}

export interface ConnectedIntegration {
  id: string;
  service: string;
  accountLabel: string;
  accountEmail: string | null;
  status: string;
  connectedAt: string;
}

// Service ids are registry slugs (e.g. "gmail", "google_calendar"). Validated
// before the id is embedded in a request body or compared locally.
const SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Connection ids are platform UUIDs; the gateway enforces the same shape
// (UUID_RE in integrations/routes.ts) before touching the DB.
const CONNECTION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidServiceId(value: unknown): value is string {
  return typeof value === "string" && SERVICE_ID_RE.test(value);
}

export function isValidConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_RE.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asList(value: unknown, envelopeKeys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of envelopeKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function asTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

export function parseAvailableIntegrations(value: unknown): AvailableIntegration[] {
  const list = asList(value, ["services", "available"]);
  const out: AvailableIntegration[] = [];
  for (const raw of list.slice(0, MAX_AVAILABLE_INTEGRATIONS)) {
    const record = asRecord(raw);
    if (!record) continue;
    const id = asTrimmedString(record.id, 64);
    if (!id) continue;
    const name = asTrimmedString(record.name, 100) ?? id;
    const category = asTrimmedString(record.category, 64) ?? "other";
    out.push({ id, name, category });
  }
  return out;
}

export function parseConnectedIntegrations(value: unknown): ConnectedIntegration[] {
  // GET / returns a bare array; POST /sync returns { synced, services }.
  const list = asList(value, ["connections", "services"]);
  const out: ConnectedIntegration[] = [];
  for (const raw of list.slice(0, MAX_CONNECTED_INTEGRATIONS)) {
    const record = asRecord(raw);
    if (!record) continue;
    const id = asTrimmedString(record.id, 64);
    const service = asTrimmedString(record.service, 64);
    if (!id || !service) continue;
    const accountLabel = asTrimmedString(record.account_label, 100) ?? service;
    const accountEmail = asTrimmedString(record.account_email, 256);
    const status = asTrimmedString(record.status, 32) ?? "active";
    const connectedAt = asTrimmedString(record.connected_at, 64) ?? "";
    out.push({ id, service, accountLabel, accountEmail, status, connectedAt });
  }
  return out;
}

// The connect endpoint returns { url, service }. The URL is opened through
// the HTTPS-only shell:open-external bridge, so refuse anything else here —
// defense in depth in front of the main-process check.
export function parseConnectUrl(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const url = asTrimmedString(record.url, 2048);
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
