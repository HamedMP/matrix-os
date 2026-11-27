import { z } from "zod/v4";
import { NotificationPreferencesSchema, type NotificationPreferences } from "@matrix-os/contracts/notifications";

type FetchGateway = (path: string, init?: RequestInit) => Promise<Response>;
export type NotificationPreferencesResult =
  | { ok: true; preferences: NotificationPreferences }
  | { ok: false; reason: "conflict" | "unsupported" | "unavailable" };
const ResponseSchema = z.object({ preferences: NotificationPreferencesSchema }).strict();

/** Parsing stays beside the shared contract; auth, routing and timeout stay in GatewayClient. */
export async function notificationPreferencesRequest(
  fetchGateway: FetchGateway,
  update?: NotificationPreferences,
): Promise<NotificationPreferencesResult> {
  try {
    if (update !== undefined && !NotificationPreferencesSchema.safeParse(update).success) return { ok: false, reason: "unavailable" };
    const response = await fetchGateway("/api/notifications/preferences", update ? {
      method: "PUT", body: JSON.stringify(update),
    } : undefined);
    if (!response.ok) return {
      ok: false,
      reason: response.status === 409 ? "conflict" : response.status === 404 ? "unsupported" : "unavailable",
    };
    const preferences = ResponseSchema.parse(await response.json()).preferences;
    if (update && preferences.revision !== update.revision + 1) return { ok: false, reason: "unavailable" };
    return { ok: true, preferences };
  } catch (error: unknown) {
    console.warn("[mobile] Notification settings unavailable", error instanceof Error ? error.name : "unknown");
    return { ok: false, reason: "unavailable" };
  }
}
