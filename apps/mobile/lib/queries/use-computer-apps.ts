import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { fetch as streamingFetch } from "expo/fetch";
import { AppIdentitySchema, readBoundedRepairJson, submitAppRepairChat, type AppRepairDiagnostic } from "@matrix-os/contracts";

import type { MobileAppBridgeRequest } from "@/lib/app-capability-bridge";

import { getAppIdentity, getAppSlug } from "@/lib/apps";
import {
  createAppSession,
  fetchActiveComputer,
  fetchInstalledApps,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL, resolveMobileAppSessionLaunchUrl } from "@/lib/storage";

export function useComputerApps() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const authEnabled = Boolean(isLoaded && isSignedIn && userId);
  const [authorization, setAuthorization] = useState<string | undefined>();
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled: authEnabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computer = activeComputer.data;
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";
  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : null;
  const apps = useQuery({
    queryKey: mobileQueryKeys.apps(userId ?? "signed-out", computerKey),
    enabled: authEnabled && Boolean(gatewayUrl),
    refetchInterval: 10_000,
    queryFn: async () => {
      const token = await getToken();
      if (!token || !gatewayUrl) throw new Error("Apps unavailable. Try again.");
      return fetchInstalledApps(token, gatewayUrl);
    },
  });

  useEffect(() => {
    let cancelled = false;
    if (!authEnabled) {
      setAuthorization(undefined);
      return;
    }
    void getToken().then((token) => {
      if (!cancelled) setAuthorization(token ? `Bearer ${token}` : undefined);
    }).catch(() => {
      if (!cancelled) setAuthorization(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [authEnabled, getToken]);

  const sortedApps = useMemo(
    () => [...(apps.data ?? [])].sort((left, right) => (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    )),
    [apps.data],
  );

  return {
    computer,
    apps: sortedApps,
    authorization,
    gatewayUrl,
    isPending: authEnabled && (
      activeComputer.isPending || (Boolean(computer) && apps.isPending)
    ),
    isError: activeComputer.isError || apps.isError,
  };
}

export function useComputerAppSession(slug: string, runtimeSlugHint?: string) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const authEnabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled: authEnabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computer = activeComputer.data;
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";
  const gatewayUrl = computer ? `${HOSTED_GATEWAY_URL}${computer.gatewayPath}` : null;
  const session = useQuery({
    queryKey: [...mobileQueryKeys.appSession(userId ?? "signed-out", computerKey, slug), runtimeSlugHint ?? "catalog"],
    enabled: authEnabled && Boolean(gatewayUrl) && Boolean(slug),
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    queryFn: async () => {
      const token = await getToken();
      if (!token || !gatewayUrl) throw new Error("App session unavailable. Try again.");
      // Route/deep-link parameters are hints, never authority for app grants.
      const installed = await fetchInstalledApps(token, gatewayUrl);
      const matches = installed.filter(app => getAppIdentity(app) === slug
        && (runtimeSlugHint === undefined || getAppSlug(app) === runtimeSlugHint));
      if (matches.length !== 1) throw new Error("App session unavailable. Try again.");
      const runtimeSlug = getAppSlug(matches[0]);
      if (installed.filter(app => getAppSlug(app) === runtimeSlug).length !== 1) throw new Error("App session unavailable. Try again.");
      const session = await createAppSession(token, gatewayUrl, runtimeSlug);
      return { ...session, appIdentity: getAppIdentity(matches[0]), runtimeSlug };
    },
  });

  const requestAppBridge = useCallback<MobileAppBridgeRequest>(async (path, init) => {
    if (!authEnabled || !gatewayUrl || !init.signal || !/^\/api\/bridge\/(?:capabilities|query|ai|ai\/routes)(?:\?|$)/.test(path)) throw new Error("App request unavailable");
    const token = await getToken();
    if (!token) throw new Error("App request unavailable");
    return streamingFetch(`${gatewayUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, signal: init.signal, redirect: "error" });
  }, [authEnabled, gatewayUrl, getToken, userId]);

  const repairApp = useCallback(async (app: string, diagnostic: AppRepairDiagnostic, signal?: AbortSignal): Promise<{ chatId: string }> => {
    if (!authEnabled || !gatewayUrl || (app !== "Matrix OS" && (app !== session.data?.appIdentity || !AppIdentitySchema.safeParse(app).success))) throw new Error("Repair chat unavailable");
    const token = await getToken();
    if (!token) throw new Error("Repair chat unavailable");
    return submitAppRepairChat(async (path, init) => {
      if (signal?.aborted) throw new Error("Repair chat unavailable");
      if (!/^\/api\/(?:chat-providers\?|chats(?:\/[a-zA-Z0-9_-]+\/turns)?$)/.test(path)) throw new Error("Repair chat unavailable");
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 12_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const response = await streamingFetch(`${gatewayUrl}${path}`, { method: init?.method ?? "GET", body: init?.body,
          headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
          signal: controller.signal, redirect: "error" });
        return readBoundedRepairJson(response as Response);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }, { app, surface: "Native Mobile", ...diagnostic });
  }, [authEnabled, gatewayUrl, getToken, session.data?.appIdentity]);

  return {
    requestAppBridge,
    repairApp,
    retrySession: () => { void activeComputer.refetch(); void session.refetch(); },
    appIdentity: session.data?.appIdentity,
    runtimeSlug: session.data?.runtimeSlug,
    launchUrl: gatewayUrl && session.data
      ? resolveMobileAppSessionLaunchUrl(gatewayUrl, session.data.launchUrl)
      : null,
    isPending: authEnabled && (
      activeComputer.isPending || (Boolean(computer) && session.isPending)
    ),
    isError: activeComputer.isError || session.isError,
  };
}

export function installedAppSlug(app: Parameters<typeof getAppIdentity>[0]): string {
  return getAppIdentity(app);
}
