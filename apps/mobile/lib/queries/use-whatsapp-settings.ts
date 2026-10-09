import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { fetchWhatsAppSettings } from "@/lib/requests/messaging";
export function useWhatsAppSettings() {
  const { userId, sessionId, isLoaded, isSignedIn, getToken } = useAuth();
  const query = useQuery({
    queryKey: ["messaging", "whatsapp", userId, sessionId],
    enabled: Boolean(isLoaded && isSignedIn && userId),
    staleTime: 0,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Sign in required");
      return fetchWhatsAppSettings(token);
    },
  });
  const { refetch } = query;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && isSignedIn) void refetch();
    });
    return () => sub.remove();
  }, [refetch, isSignedIn]);
  return query;
}
