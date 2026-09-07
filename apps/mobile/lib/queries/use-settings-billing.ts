import { useAuth } from "@clerk/clerk-expo";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  createMobileBillingPortal,
  fetchActiveComputer,
  fetchMobileBillingStatus,
  mobileQueryKeys,
} from "@/lib/requests";

export function useSettingsBilling() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Billing information unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const runtimeSlot = activeComputer.data?.runtimeSlot;
  const billing = useQuery({
    queryKey: mobileQueryKeys.billing(userId ?? "signed-out", runtimeSlot ?? "none"),
    enabled: enabled && Boolean(runtimeSlot),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !runtimeSlot) throw new Error("Billing information unavailable.");
      return fetchMobileBillingStatus(token, runtimeSlot);
    },
  });
  const portal = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Billing portal unavailable.");
      return createMobileBillingPortal(token);
    },
  });

  return {
    billing: billing.data,
    isPending: enabled && (activeComputer.isPending || (Boolean(runtimeSlot) && billing.isPending)),
    isError: activeComputer.isError || billing.isError,
    openPortal: portal.mutateAsync,
    isOpeningPortal: portal.isPending,
  };
}
