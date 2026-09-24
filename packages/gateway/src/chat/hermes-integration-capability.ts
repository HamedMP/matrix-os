import { createHash, randomBytes } from "node:crypto";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

const MAX_ACTIVE = 128;
const LIFETIME_MS = 35 * 60_000;
const active = new Map<string, { actorId: string; expiresAt: number }>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sweep(now: number): void {
  for (const [key, value] of active) {
    if (value.expiresAt <= now) active.delete(key);
  }
}

export function issueHermesIntegrationCapability(actorId: string): { token: string; revoke(): void } {
  if (!SAFE_PRINCIPAL_USER_ID.test(actorId)) throw new Error("Invalid Hermes actor");
  const now = Date.now();
  sweep(now);
  if (active.size >= MAX_ACTIVE) throw new Error("Hermes integration capability limit reached");
  const token = randomBytes(32).toString("hex");
  const key = digest(token);
  active.set(key, { actorId, expiresAt: now + LIFETIME_MS });
  return { token, revoke: () => { active.delete(key); } };
}

export function resolveHermesIntegrationCapability(token: string, path: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  if (path !== "/api/integrations" && !path.startsWith("/api/integrations/")
    && path !== "/api/jev" && !path.startsWith("/api/jev/")) return null;
  const now = Date.now();
  sweep(now);
  return active.get(digest(token))?.actorId ?? null;
}
