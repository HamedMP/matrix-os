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
/** Every API created in this tab, so sign-out can end their home sessions (S06 / T034). */
const liveApis = new Set<CollaborationDirectApi>();

/**
 * S06 / T033: the shell talks to each shared resource's home through the direct
 * transport; the platform (same origin as the shell) only issues tickets and
 * lists metadata. The selected computer never influences where a scope is served.
 */
export function createShellCollaborationApi(baseUrl: string): CollaborationDirectApi {
  const api = createCollaborationDirectApi({ platformBaseUrl: baseUrl });
  if (liveApis.size >= MAX_LIVE_APIS) {
    const oldest = liveApis.values().next().value;
    if (oldest) { oldest.direct.close(); liveApis.delete(oldest); }
  }
  liveApis.add(api);
  return api;
}

/** Ends every direct session this tab holds; called before the actor signs out or the app session is cleared. */
export function closeShellCollaborationSessions(): void {
  for (const api of liveApis) {
    try {
      api.direct.close();
    } catch (error: unknown) {
      console.warn("[collaboration] session close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  liveApis.clear();
}
