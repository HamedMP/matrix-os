import { createHash, randomBytes } from "node:crypto";
import { ChatAgentIdSchema, JevInboxTriageBindingSchema, type JevInboxTriageBinding } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

const MAX_ACTIVE = 128;
const LIFETIME_MS = 35 * 60_000;
const JevScopeSchema = z.object({
  kind: z.literal("jev_inbox_preview"),
  runId: z.string().min(1).max(160),
  agentId: ChatAgentIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  account: JevInboxTriageBindingSchema.omit({ version: true, ownerId: true }),
}).strict();
export type HermesJevScope = { kind: "jev_inbox_preview"; runId: string; agentId: string;
  revision: number; account: Omit<JevInboxTriageBinding, "version" | "ownerId"> };
const active = new Map<string, { actorId: string; expiresAt: number; scope?: HermesJevScope }>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sweep(now: number): void {
  for (const [key, value] of active) {
    if (value.expiresAt <= now) active.delete(key);
  }
}

export function issueHermesIntegrationCapability(actorId: string, scope?: HermesJevScope): { token: string; revoke(): void } {
  if (!SAFE_PRINCIPAL_USER_ID.test(actorId)) throw new Error("Invalid Hermes actor");
  const validatedScope = scope ? JevScopeSchema.parse(scope) : undefined;
  const now = Date.now();
  sweep(now);
  if (active.size >= MAX_ACTIVE) throw new Error("Hermes integration capability limit reached");
  const token = randomBytes(32).toString("hex");
  const key = digest(token);
  active.set(key, { actorId, expiresAt: now + LIFETIME_MS, ...(validatedScope ? { scope: validatedScope } : {}) });
  return { token, revoke: () => { active.delete(key); } };
}

export function revokeHermesJevCapabilitiesForAgent(actorId: string, agentId: string): void {
  for (const [key, value] of active) {
    if (value.actorId === actorId && value.scope?.agentId === agentId) active.delete(key);
  }
}

export function resolveHermesIntegrationCapability(token: string, method: string, path: string): string | null;
export function resolveHermesIntegrationCapability(token: string, path: string): string | null;
export function resolveHermesIntegrationCapability(token: string, methodOrPath: string, pathArg?: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const method = pathArg ? methodOrPath : "GET";
  const path = pathArg ?? methodOrPath;
  const now = Date.now();
  sweep(now);
  const record = active.get(digest(token));
  if (!record) return null;
  if (record.scope) return method === "POST" && path === "/api/jev/inbox/preview" ? record.actorId : null;
  if (path !== "/api/integrations" && !path.startsWith("/api/integrations/")
    && path !== "/api/jev" && !path.startsWith("/api/jev/")) return null;
  return record.actorId;
}
