import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import { getAppSlug } from "@/lib/apps";
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

export function useComputerAppSession(slug: string) {
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
    queryKey: mobileQueryKeys.appSession(userId ?? "signed-out", computerKey, slug),
    enabled: authEnabled && Boolean(gatewayUrl) && Boolean(slug),
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    queryFn: async () => {
      const token = await getToken();
      if (!token || !gatewayUrl) throw new Error("App session unavailable. Try again.");
      return createAppSession(token, gatewayUrl, slug);
    },
  });

  return {
    launchUrl: gatewayUrl && session.data
      ? resolveMobileAppSessionLaunchUrl(gatewayUrl, session.data.launchUrl)
      : null,
    isPending: authEnabled && (
      activeComputer.isPending || (Boolean(computer) && session.isPending)
    ),
    isError: activeComputer.isError || session.isError,
  };
}

export function installedAppSlug(app: Parameters<typeof getAppSlug>[0]): string {
  return getAppSlug(app);
}
