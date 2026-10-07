import { useLayoutEffect, useMemo } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchActiveComputer, mobileQueryKeys } from "@/lib/requests";
import { createNativeEditionRuntime } from "./native-runtime";
export function useNativeEditionRuntime() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const enabled = Boolean(isLoaded && isSignedIn && userId);
  const query = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable");
      return fetchActiveComputer(token);
    },
  });
  const computer = query.data;
  const identity =
    enabled && computer
      ? JSON.stringify([userId, computer.handle, computer.runtimeSlot])
      : null;
  const session = useMemo(() => {
    if (!identity || !computer || !userId) return null;
    let authorized = false;
    return {
      runtime: createNativeEditionRuntime({
        ownerId: userId,
        computer,
        getToken,
        storage: AsyncStorage,
        isCurrent: () => authorized,
      }),
      activate: () => {
        authorized = true;
      },
      revoke: () => {
        authorized = false;
      },
    };
  }, [identity, computer, getToken, userId]);
  useLayoutEffect(() => {
    session?.activate();
    return () => session?.revoke();
  }, [session]);
  return {
    runtime: session?.runtime ?? null,
    identity,
    computer,
    getToken,
    isPending: enabled && query.isPending,
    isError: query.isError,
  };
}
