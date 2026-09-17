import { z } from "zod/v4";
import {
  MatrixBillingStatusSchema,
  type MatrixBillingStatus,
} from "@matrix-os/contracts/billing";
import { BackupStatusSchema, type BackupStatus } from "@matrix-os/contracts/sync";
import {
  SyncRemoteStatusResponseSchema,
  type SyncRemoteStatusResponse,
} from "@matrix-os/contracts/sync";

import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

const SystemInfoSchema = z.looseObject({
  version: z.string(),
  runningVersion: z.string(),
  model: z.string(),
  effort: z.string(),
  capabilities: z.looseObject({ collaboration: z.boolean() }).optional(),
  release: z.looseObject({ version: z.string() }).optional(),
});

const OkResponseSchema = z.looseObject({ ok: z.literal(true) });
const BillingPortalSchema = z.object({ url: z.url() }).strict();

export type MobileSystemInfo = z.infer<typeof SystemInfoSchema>;
export type MobileBillingStatus = MatrixBillingStatus;

export function fetchMobileBackupStatus(
  clerkToken: string,
  gatewayUrl: string,
): Promise<BackupStatus> {
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/sync/backup-status"),
    token: clerkToken,
    schema: BackupStatusSchema,
    errorMessage: "Backup health unavailable. Try again.",
    maxResponseBytes: 32 * 1024,
  });
}

export function fetchMobileSyncStatus(
  clerkToken: string,
  gatewayUrl: string,
): Promise<SyncRemoteStatusResponse> {
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/sync/status"),
    token: clerkToken,
    schema: SyncRemoteStatusResponseSchema,
    errorMessage: "Sync health unavailable. Try again.",
    maxResponseBytes: 32 * 1024,
  });
}

export function fetchMobileSystemInfo(
  clerkToken: string,
  gatewayUrl: string,
): Promise<MobileSystemInfo> {
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/system/info"),
    token: clerkToken,
    schema: SystemInfoSchema,
    errorMessage: "System information unavailable. Try again.",
  });
}

export function fetchMobileBillingStatus(
  clerkToken: string,
  runtimeSlot: string,
): Promise<MobileBillingStatus> {
  const url = new URL(`${HOSTED_GATEWAY_URL}/billing/status`);
  url.searchParams.set("runtimeSlot", runtimeSlot);
  return fetchAuthenticatedJson({
    url: url.toString(),
    token: clerkToken,
    schema: MatrixBillingStatusSchema,
    errorMessage: "Billing information unavailable. Try again.",
  });
}

export async function createMobileBillingPortal(clerkToken: string): Promise<string> {
  const response = await fetchAuthenticatedJson({
    url: `${HOSTED_GATEWAY_URL}/billing/portal`,
    token: clerkToken,
    schema: BillingPortalSchema,
    errorMessage: "Billing portal unavailable. Try again.",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent: "manage", returnPath: "/" }),
  });
  return response.url;
}

export async function updatePushRegistration(input: {
  clerkToken: string;
  gatewayUrl: string;
  expoPushToken: string;
  platform: string;
  enabled: boolean;
}): Promise<void> {
  await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(input.gatewayUrl, "/api/push/register"),
    token: input.clerkToken,
    schema: OkResponseSchema,
    errorMessage: "Push notification settings could not be saved. Try again.",
    method: input.enabled ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.enabled
      ? { token: input.expoPushToken, platform: input.platform }
      : { token: input.expoPushToken }),
  });
}
