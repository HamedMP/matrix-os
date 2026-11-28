import { withCapabilityLookupTimeout } from "./capability-lookup-timeout.js";
import type { PlatformDb } from "../platform-db.js";
import { capabilityIdsForConnectedServices } from "../onboarding/integration-capabilities.js";

const PLATFORM_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readConnectedCapabilityIds(ownerId: string, options: {
  platformDb: PlatformDb | null; internalIntegrationBaseUrl: string | null; internalPlatformToken?: string;
}): Promise<string[]> {
  const { platformDb, internalIntegrationBaseUrl, internalPlatformToken } = options;
  if (platformDb) {
    try {
      const dbForLookup = platformDb;
      const services = await withCapabilityLookupTimeout(async () => {
        const user = await dbForLookup.getUserByClerkId(ownerId);
        const platformUserId = user?.id ?? (PLATFORM_USER_ID_PATTERN.test(ownerId) ? ownerId : null);
        if (!platformUserId) return [];
        return dbForLookup.listConnectedServices(platformUserId);
      });
      return capabilityIdsForConnectedServices(services.map((service) => service.service));
    } catch (err: unknown) {
      console.warn("[integrations] platform capability lookup failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }
  if (!internalIntegrationBaseUrl) return [];
  try {
    const headers = new Headers({ Accept: "application/json" });
    if (internalPlatformToken) headers.set("authorization", `Bearer ${internalPlatformToken}`);
    const response = await fetch(internalIntegrationBaseUrl, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const body = await response.json() as unknown;
    const connections = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { connections?: unknown }).connections)
        ? (body as { connections: unknown[] }).connections
        : [];
    return capabilityIdsForConnectedServices(connections.flatMap((connection) =>
      connection && typeof connection === "object" && typeof (connection as { service?: unknown }).service === "string"
        ? [(connection as { service: string }).service]
        : [],
    ));
  } catch (err: unknown) {
    console.warn("[integrations] capability connection lookup failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
