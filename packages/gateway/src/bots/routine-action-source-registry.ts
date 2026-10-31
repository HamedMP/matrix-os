import type { CanonicalProviderRunEvent } from "../chat/provider-adapter.js";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { Transaction } from "kysely";
import type { RoutineCliAction } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import { RoutineCliSourceContextSchema, type RoutineCliSourceContext } from "./routine-cli-source-context.js";
import { RoutineCliError } from "./routine-cli-errors.js";

export const RoutineSourcePolicySchema = z.strictObject({
  live: z.boolean(), scope: z.enum(["personal", "shared", "org"]),
  interactionMode: z.enum(["default", "plan", "review"]),
  permissionMode: z.enum(["full_access", "supervised", "auto", "auto_accept_edits", "unsupported"]),
  originCeiling: z.enum(["read", "exact", "full"]), revision: z.string().min(1).max(128),
});
export type RoutineSourcePolicy = z.infer<typeof RoutineSourcePolicySchema>;
export const routineActionHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function routineActionPolicy(source: RoutineCliSourceContext, policyValue: RoutineSourcePolicy, action: RoutineCliAction): "deny" | "allow" | "ask" {
  const parsed = RoutineSourcePolicySchema.safeParse(policyValue);
  if (!parsed.success || !parsed.data.live || !source.actions.includes(action)) return "deny";
  const policy = parsed.data;
  if (action === "read") return "allow";
  if (policy.scope !== "personal" || policy.interactionMode !== "default" || policy.permissionMode === "unsupported" || policy.originCeiling === "read") return "deny";
  return source.identity.kind !== "terminal_launch" && policy.permissionMode === "full_access" && policy.originCeiling === "full" ? "allow" : "ask";
}
export interface RoutineSourceProducer {
  source: RoutineCliSourceContext;
  /** Actual trusted adapter policy/current origin ceiling, never model IDs/modes. Must be bounded local. */
  readPolicy(): RoutineSourcePolicy;
  /** Actual native run/turn/session/launch generation + DB checks only; no UI/network wait. */
  validateWithin(source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction): Promise<boolean>;
  signal: AbortSignal;
  /** Actual Chat run publisher. Terminal has no synthetic Chat events. */
  publish?: (event: CanonicalProviderRunEvent) => void;
}
export interface RoutineSourceHandle { readonly source: RoutineCliSourceContext; readonly signal: AbortSignal }
/** Internal producer registry. No HTTP registration or source/JWT/bootstrap fallback.
 * <=256 entries, source lifetime <=30min, recurring eviction, source-close and shutdown drains. */
export function createRoutineActionSourceRegistry(options: { now?: () => number; maxSources?: number } = {}) {
  const entries = new Map<string, { handle: RoutineSourceHandle; producer: RoutineSourceProducer; controller: AbortController; detach(): void }>();
  const now = options.now ?? Date.now, max = options.maxSources ?? 256;
  if (!Number.isInteger(max) || max < 1 || max > 256) throw new Error("Routine source unavailable");
  let closed = false;
  const remove = (key: string) => { const entry = entries.get(key); if (!entry) return; entries.delete(key); entry.detach(); entry.controller.abort(); };
  const sweep = () => { for (const [key, entry] of entries) if (entry.producer.signal.aborted || Date.parse(entry.handle.source.expiresAt) <= now()) remove(key); };
  const timer = setInterval(sweep, 1000); timer.unref?.();
  const read = (source: RoutineCliSourceContext) => {
    sweep(); if (closed) return null;
    const parsedSource = RoutineCliSourceContextSchema.safeParse(source); if (!parsedSource.success) return null;
    const entry = entries.get(routineActionHash(parsedSource.data)); if (!entry || entry.controller.signal.aborted) return null;
    let raw: unknown;
    try { raw = entry.producer.readPolicy(); } catch (error: unknown) {
      console.warn("[routine-action] Current policy unavailable", error instanceof Error ? error.name : "UnknownError"); remove(routineActionHash(parsedSource.data)); return null;
    }
    const parsed = RoutineSourcePolicySchema.safeParse(raw);
    return parsed.success && parsed.data.live ? { ...entry, policy: parsed.data, fingerprint: routineActionHash(parsed.data) } : null;
  };
  return {
    register(producer: RoutineSourceProducer): RoutineSourceHandle {
      sweep(); const source = RoutineCliSourceContextSchema.parse(producer.source), key = routineActionHash(source);
      if (closed || entries.size >= max || entries.has(key) || typeof producer.readPolicy !== "function" || typeof producer.validateWithin !== "function"
        || !producer.signal || producer.signal.aborted || Date.parse(source.issuedAt) > now() || Date.parse(source.expiresAt) <= now()
        || Date.parse(source.expiresAt) - now() > 30 * 60_000) throw new RoutineCliError("permission_denied");
      RoutineSourcePolicySchema.parse(producer.readPolicy());
      const identityKey = (value: RoutineCliSourceContext) => routineActionHash([value.ownerId, value.computerId, value.harness, value.identity]);
      for (const [oldKey, entry] of entries) if (identityKey(entry.handle.source) === identityKey(source)) remove(oldKey);
      Object.freeze(source.identity); Object.freeze(source.actions); Object.freeze(source);
      const controller = new AbortController(), handle = Object.freeze({ source, signal: controller.signal });
      const abort = () => remove(key); producer.signal.addEventListener("abort", abort, { once: true });
      entries.set(key, { handle, controller, producer, detach: () => producer.signal.removeEventListener("abort", abort) });
      return handle;
    },
    read,
    has(handle: RoutineSourceHandle) { return read(handle.source)?.handle === handle; },
    revoke(handle: RoutineSourceHandle) { if (read(handle.source)?.handle === handle) remove(routineActionHash(RoutineCliSourceContextSchema.parse(handle.source))); },
    async validateWithin(source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction) {
      const before = read(source);
      if (!before || action && routineActionPolicy(source, before.policy, action) === "deny") return false;
      if (await before.producer.validateWithin(source, trx, action) !== true) return false;
      const after = read(source); return after?.handle === before.handle && after.fingerprint === before.fingerprint;
    },
    close() { closed = true; clearInterval(timer); for (const key of [...entries.keys()]) remove(key); },
  };
}
export type RoutineActionSourceRegistry = ReturnType<typeof createRoutineActionSourceRegistry>;
