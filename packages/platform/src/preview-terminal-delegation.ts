import { createHmac } from "node:crypto";
import {
  PreviewTerminalDelegationSchema,
  PREVIEW_TERMINAL_MAX_AGE_SECONDS,
  PREVIEW_TERMINAL_SIGNATURE_DOMAIN,
  isPreviewTerminalPath,
} from "@matrix-os/contracts";
import type { UserMachineRecord } from "./db.js";
import { canClerkUserAccessMachine, isPreviewMachine } from "./customer-vps-preview.js";
import { buildPlatformVerificationToken } from "./platform-token.js";

type PreviewMachine = Pick<UserMachineRecord,
  "handle" | "runtimeSlot" | "provisioningClass" | "clerkUserId" | "accessClerkUserIds">;

/** Issue from a freshly authorized DB record, never from incoming headers. */
export function buildPreviewTerminalDelegation(options: {
  machine: PreviewMachine;
  actorId: string;
  path: string;
  platformSecret: string;
  now?: number;
}): string | undefined {
  const { machine, actorId, path, platformSecret } = options;
  if (!platformSecret || !isPreviewTerminalPath(path) || !isPreviewMachine(machine)
    || actorId === machine.clerkUserId || !canClerkUserAccessMachine(machine, actorId)) return undefined;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const delegation = PreviewTerminalDelegationSchema.parse({
    version: 1,
    scope: "preview-terminal",
    provisioningClass: "preview",
    role: "preview-collaborator",
    actorId,
    ownerId: machine.clerkUserId,
    handle: machine.handle,
    runtimeSlot: machine.runtimeSlot,
    issuedAt: now,
    expiresAt: now + PREVIEW_TERMINAL_MAX_AGE_SECONDS,
  });
  const payload = Buffer.from(JSON.stringify(delegation)).toString("base64url");
  const key = buildPlatformVerificationToken(machine.handle, platformSecret);
  const signature = createHmac("sha256", key)
    .update(`${PREVIEW_TERMINAL_SIGNATURE_DOMAIN}${payload}`).digest("hex");
  return `${payload}.${signature}`;
}
