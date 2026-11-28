import { z } from "zod/v4";
import {
  MatrixBillingStatusSchema,
  type MatrixBillingStatus,
} from "@matrix-os/contracts";

import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { buildGatewayRequestUrl, fetchAuthenticatedJson, type RequestToken } from "./http";

export const MobileSystemInfoSchema = z.looseObject({
  version: z.string(),
  runningVersion: z.string(),
  model: z.string(),
  effort: z.string(),
  capabilities: z.looseObject({ collaboration: z.boolean() }).optional(),
  release: z.looseObject({ version: z.string() }).optional(),
});

const OkResponseSchema = z.looseObject({ ok: z.literal(true) });
const PushRegistrationStatusSchema = z.strictObject({ enabled: z.boolean().nullable(), registered: z.boolean() });
const PushRefreshResponseSchema = z.strictObject({ ok: z.literal(true), registered: z.boolean() });
const BillingPortalSchema = z.object({ url: z.url() }).strict();

export type MobileSystemInfo = z.infer<typeof MobileSystemInfoSchema>;
export type MobileBillingStatus = MatrixBillingStatus;

export function fetchMobileSystemInfo(
  clerkToken: RequestToken,
  gatewayUrl: string,
): Promise<MobileSystemInfo> {
  return fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(gatewayUrl, "/api/system/info"),
    token: clerkToken,
    schema: MobileSystemInfoSchema,
    errorMessage: "System information unavailable. Try again.",
  });
}

export function fetchMobileBillingStatus(
  clerkToken: string,
  runtimeSlot: string,
): Promise<MobileBillingStatus> {
  const url = new URL(`${HOSTED_GATEWAY_URL}/billing/status`);
  url.searchParams.set("runtimeSlot", runtimeSlot);
  url.searchParams.set("trialOfferVersion", "2");
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
  clerkToken: RequestToken;
  gatewayUrl: string;
  expoPushToken: string;
  platform: string;
  enabled: boolean;
  identity?: string;
  deliveryToken?: string;
}): Promise<void> {
  await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(input.gatewayUrl, "/api/push/register"),
    token: input.clerkToken,
    schema: OkResponseSchema,
    errorMessage: "Push notification settings could not be saved. Try again.",
    method: input.enabled ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.enabled
      ? { token: input.expoPushToken, platform: input.platform, mode: "enable", ...(input.identity ? { identity: input.identity } : {}) }
      : { token: input.expoPushToken, ...(input.deliveryToken ? { deliveryToken: input.deliveryToken } : {}) }),
  });
}

/** Conditional refresh cannot grant consent after an explicit opt-out. */
export async function refreshPushRegistration(input: {
  clerkToken: RequestToken; gatewayUrl: string; expoPushToken: string; platform: string; identity: string;
}): Promise<boolean> {
  const response = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(input.gatewayUrl, "/api/push/register"), token: input.clerkToken,
    schema: PushRefreshResponseSchema, errorMessage: "Push notification settings could not be saved. Try again.",
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: input.expoPushToken, platform: input.platform, identity: input.identity, mode: "refresh" }),
  });
  return response.registered;
}

export async function fetchPushRegistrationStatus(input: {
  clerkToken: RequestToken;
  gatewayUrl: string;
  expoPushToken: string;
}): Promise<boolean | null> {
  const response = await fetchAuthenticatedJson({
    url: buildGatewayRequestUrl(input.gatewayUrl, "/api/push/status"),
    token: input.clerkToken,
    schema: PushRegistrationStatusSchema,
    errorMessage: "Push notification settings unavailable. Try again.",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: input.expoPushToken }),
  });
  return response.enabled;
}
