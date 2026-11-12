import { createCollaborationDirectApi, type CollaborationDirectApi } from "@matrix-os/ui";
import { z } from "zod/v4";

const MachineIdSchema = z.uuid();
const SystemInfoSchema = z.object({
  runtime: z.object({
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).nullable(),
    runtimeSlot: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    machineId: z.string().nullable().optional(),
  }).passthrough(),
  capabilities: z.object({
    collaboration: z.boolean(),
  }).passthrough().optional(),
}).passthrough();

export function collaborationRuntimeFromSystemInfo(value: unknown): {
  handle: string | null;
  runtimeSlot: string;
  runtimeId: string | null;
  collaborationEnabled: boolean;
} {
  const { runtime, capabilities } = SystemInfoSchema.parse(value);
  const collaborationEnabled = capabilities?.collaboration === true;
  const machineId = MachineIdSchema.safeParse(runtime.machineId);
  return {
    handle: runtime.handle,
    runtimeSlot: runtime.runtimeSlot,
    runtimeId: collaborationEnabled && machineId.success ? `vps:${machineId.data}` : null,
    collaborationEnabled,
  };
}

const MAX_LIVE_APIS = 32;
interface LiveApiEntry { api: CollaborationDirectApi; references: number }
/** One shared client per platform origin; mounted viewers hold references so LRU pressure never closes a live window. */
const liveApis = new Map<string, LiveApiEntry>();
const apiOrigins = new WeakMap<CollaborationDirectApi, string>();

/**
 * S06 / T033: the shell talks to each shared resource's home through the direct
 * transport; the platform (same origin as the shell) only issues tickets and
 * lists metadata. The selected computer never influences where a scope is served.
 */
export function createShellCollaborationApi(baseUrl: string): CollaborationDirectApi {
  const origin = new URL(baseUrl).origin;
  const existing = liveApis.get(origin);
  if (existing) {
    existing.references += 1;
    return existing.api;
  }
  if (liveApis.size >= MAX_LIVE_APIS) throw new Error("Too many collaboration origins");
  const api = createCollaborationDirectApi({ platformBaseUrl: baseUrl });
  liveApis.set(origin, { api, references: 1 });
  apiOrigins.set(api, origin);
  return api;
}

/** Ends every direct session this tab holds; called before the actor signs out or the app session is cleared. */
export function closeShellCollaborationSessions(): void {
  for (const { api } of liveApis.values()) {
    try {
      api.direct.close();
    } catch (error: unknown) {
      console.warn("[collaboration] session close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  liveApis.clear();
}

export function releaseShellCollaborationApi(api: CollaborationDirectApi): void {
  const origin = apiOrigins.get(api);
  if (!origin) return;
  const entry = liveApis.get(origin);
  if (!entry || entry.api !== api) return;
  entry.references -= 1;
  if (entry.references > 0) return;
  liveApis.delete(origin);
  apiOrigins.delete(api);
  api.direct.close();
}
