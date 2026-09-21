import { createCollaborationDirectApi, type CollaborationDirectApi } from "@matrix-os/ui";
import { z } from "zod/v4";

const SystemInfoSchema = z.looseObject({
  runtime: z.looseObject({ machineId: z.string().nullable().optional() }),
  capabilities: z.looseObject({ collaboration: z.boolean() }).optional(),
});

export function collaborationRuntimeIdFromSystemInfo(value: unknown): string | null {
  const parsed = SystemInfoSchema.safeParse(value);
  if (!parsed.success || parsed.data.capabilities?.collaboration !== true) return null;
  const machineId = z.uuid().safeParse(parsed.data.runtime.machineId);
  return machineId.success ? `vps:${machineId.data}` : null;
}

const MAX_LIVE_APIS = 32;
const liveApis = new Set<CollaborationDirectApi>();

/**
 * S06 / T033: Electron Desktop uses the same direct client as Web Canvas and
 * Web Desktop. The renderer is not an https origin, so it presents the
 * platform origin as its client origin (the home's allowlist names it);
 * every home session is still bound to this renderer's own proof key.
 */
export function createDesktopCollaborationApi(platformHost: string): CollaborationDirectApi | null {
  try {
    if (!platformHost) return null;
    const api = createCollaborationDirectApi({ platformBaseUrl: platformHost, clientOrigin: new URL(platformHost).origin });
    if (liveApis.size >= MAX_LIVE_APIS) {
      const oldest = liveApis.values().next().value;
      if (oldest) { oldest.direct.close(); liveApis.delete(oldest); }
    }
    liveApis.add(api);
    return api;
  } catch (error: unknown) {
    console.warn("[chat-collaboration] platform origin unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

/** Ends every direct session this renderer holds; called when the desktop auth state changes. */
export function closeDesktopCollaborationSessions(): void {
  for (const api of liveApis) {
    try {
      api.direct.close();
    } catch (error: unknown) {
      console.warn("[chat-collaboration] session close failed", error instanceof Error ? error.name : "UnknownError");
    }
  }
  liveApis.clear();
}
