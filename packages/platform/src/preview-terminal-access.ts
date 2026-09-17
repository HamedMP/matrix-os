import { createHmac } from "node:crypto";
import type { UserMachineRecord } from "./db.js";
import { canClerkUserAccessMachine, isPreviewMachine } from "./customer-vps-preview.js";
import { buildPlatformVerificationToken } from "./platform-token.js";

export const PREVIEW_TERMINAL_ACCESS_HEADER = "x-platform-preview-terminal";

type PreviewMachine = Pick<UserMachineRecord,
  "handle" | "runtimeSlot" | "provisioningClass" | "clerkUserId" | "accessClerkUserIds">;

function isPreviewTerminalPath(path: string): boolean {
  return path.startsWith("/api/terminal/") || path === "/ws/terminal/tab";
}

/** Build only from the current server-side machine record after actor authentication. */
export function buildPreviewTerminalAccess(options: {
  machine: PreviewMachine;
  actorId: string;
  path: string;
  platformSecret: string;
}): string | undefined {
  const { machine, actorId, path, platformSecret } = options;
  if (!platformSecret || !isPreviewTerminalPath(path) || !isPreviewMachine(machine)
    || actorId === machine.clerkUserId || !canClerkUserAccessMachine(machine, actorId)) return undefined;
  const key = buildPlatformVerificationToken(machine.handle, platformSecret);
  const signature = createHmac("sha256", key)
    .update(JSON.stringify(["preview-terminal", actorId, machine.clerkUserId, machine.runtimeSlot]))
    .digest("hex");
  return `${machine.clerkUserId}.${signature}`;
}
