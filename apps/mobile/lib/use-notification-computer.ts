import { useCallback, useMemo } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useGateway } from "@/app/_layout";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { GatewayClient } from "@/lib/gateway-client";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import type { PushRegistrationSession } from "@/lib/push";

/** Pins preferences, device registration and foreground refresh to one computer. */
export function useNotificationComputer() {
  const selected = useGateway();
  const active = useActiveGateway();
  const { userId } = useAuth();
  // A bare cloud URL follows the platform's active computer. An explicit local
  // selection (including a preview/runtime query) already names the target.
  const needsActive = selected.gateway?.url === HOSTED_GATEWAY_URL;
  const url = needsActive ? active.gatewayUrl : selected.gateway?.url ?? null;
  const source = selected.client;
  const client = useMemo(() => {
    if (!source || !url) return null;
    return needsActive ? new GatewayClient(url, async () => (await source.getAuthToken()) ?? null) : source;
  }, [source, url, needsActive]);
  const baseName = needsActive ? active.computer?.label ?? active.computer?.handle : selected.gateway?.name;
  const runtime = needsActive ? active.computer?.runtimeSlot : selected.gateway?.runtimeSlot;
  const name = baseName ? `${baseName}${runtime && runtime !== "primary" ? ` (${runtime})` : ""}` : null;
  const address = useMemo(() => {
    if (!url) return null;
    const target = new URL(url);
    // The connection address disambiguates generic self-hosted names. Never
    // render URL credentials or query parameters; the runtime is named above.
    return `${target.origin}${target.pathname === "/" ? "" : target.pathname}`;
  }, [url]);
  const key = `${userId ?? "self-hosted"}:${url ?? "none"}`;
  const session = useCallback(async (): Promise<PushRegistrationSession | null> => {
    if (!client || !url) return null;
    const getToken = async () => (await client.getAuthToken()) ?? null;
    return await getToken() ? { clerkToken: getToken, gatewayUrl: url, scopeKey: key } : null;
  }, [client, url, key]);
  return useMemo(() => ({ client, url, key, name, address, session }), [client, url, key, name, address, session]);
}

export type NotificationComputer = ReturnType<typeof useNotificationComputer>;
