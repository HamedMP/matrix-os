import { createCollaborationBrowserApi } from "@matrix-os/ui";
import { z } from "zod/v4";

const SystemInfoSchema = z.looseObject({
  runtime: z.looseObject({ machineId: z.string().nullable().optional() }),
});

export function collaborationRuntimeIdFromSystemInfo(value: unknown): string | null {
  const parsed = SystemInfoSchema.safeParse(value);
  if (!parsed.success) return null;
  const machineId = z.uuid().safeParse(parsed.data.runtime.machineId);
  return machineId.success ? `vps:${machineId.data}` : null;
}

export function createDesktopCollaborationApi(platformHost: string) {
  try {
    return platformHost ? createCollaborationBrowserApi({ baseUrl: platformHost }) : null;
  } catch (error: unknown) {
    console.warn("[chat-collaboration] platform origin unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
