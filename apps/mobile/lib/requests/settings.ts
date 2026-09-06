import { z } from "zod/v4";

import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "./http";

const SystemInfoSchema = z.object({
  version: z.string(),
  runningVersion: z.string(),
  model: z.string(),
  effort: z.string(),
  release: z.object({ version: z.string() }).passthrough().optional(),
}).passthrough();

const BillingStatusSchema = z.object({
  entitlement: z.object({
    planSlug: z.enum(["matrix_starter", "matrix_builder", "matrix_max", "internal"]),
    status: z.string(),
    source: z.string(),
    stripeSubscriptionId: z.string().nullable(),
    billingInterval: z.enum(["monthly", "annual"]).nullable().optional(),
  }).passthrough().nullable(),
}).passthrough();

const OkResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const BillingPortalSchema = z.object({ url: z.url() }).strict();

export type MobileSystemInfo = z.infer<typeof SystemInfoSchema>;
export type MobileBillingStatus = z.infer<typeof BillingStatusSchema>;

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
    schema: BillingStatusSchema,
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
