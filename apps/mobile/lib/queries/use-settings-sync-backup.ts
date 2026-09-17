import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";

import {
  fetchActiveComputer,
  fetchMobileBackupStatus,
  fetchMobileSyncStatus,
  mobileQueryKeys,
} from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";

export function useSettingsSyncBackup() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Backup health unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computer = activeComputer.data;
  const computerKey = computer ? `${computer.handle}:${computer.runtimeSlot}` : "none";
  const backup = useQuery({
    queryKey: mobileQueryKeys.syncBackup(userId ?? "signed-out", computerKey),
    enabled: enabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Backup health unavailable.");
      return fetchMobileBackupStatus(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
  });
  const syncStatus = useQuery({
    queryKey: mobileQueryKeys.syncStatus(userId ?? "signed-out", computerKey),
    enabled: enabled && Boolean(computer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !computer) throw new Error("Sync health unavailable.");
      return fetchMobileSyncStatus(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`);
    },
  });

  return {
    backup: backup.data,
    syncStatus: syncStatus.data,
    isPending: enabled && (
      activeComputer.isPending
      || (Boolean(computer) && (backup.isPending || syncStatus.isPending))
    ),
    isError: activeComputer.isError
      || backup.isError
      || syncStatus.isError
      || (enabled && !activeComputer.isPending && !computer),
  };
}
