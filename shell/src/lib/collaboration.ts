import { createCollaborationBrowserApi } from "@matrix-os/ui";
import { z } from "zod/v4";

const MachineIdSchema = z.uuid();
const SystemInfoSchema = z.object({
  runtime: z.object({
    handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).nullable(),
    runtimeSlot: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    machineId: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

export function collaborationRuntimeFromSystemInfo(value: unknown): {
  handle: string | null;
  runtimeSlot: string;
  runtimeId: string | null;
} {
  const { runtime } = SystemInfoSchema.parse(value);
  const machineId = MachineIdSchema.safeParse(runtime.machineId);
  return {
    handle: runtime.handle,
    runtimeSlot: runtime.runtimeSlot,
    runtimeId: machineId.success ? `vps:${machineId.data}` : null,
  };
}

export function createShellCollaborationApi(baseUrl: string) {
  return createCollaborationBrowserApi({ baseUrl });
}
