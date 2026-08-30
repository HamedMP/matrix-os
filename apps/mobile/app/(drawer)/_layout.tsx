import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import { useAuth } from "@clerk/clerk-expo";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet } from "react-native";
import { Drawer, type DrawerContentComponentProps } from "expo-router/drawer";

import { Icon } from "@/components/ui";
import { MockDrawerContent } from "@/components/mock-shell/MockDrawerContent";
import { mockColors } from "@/components/mock-shell/theme";
import { fetchActiveComputer, fetchConversations, mobileQueryKeys } from "@/lib/requests";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { semanticColors } from "@/lib/theme";

export default function DrawerLayout() {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth();
  const queryEnabled = Boolean(isLoaded && isSignedIn && userId);
  const activeComputer = useQuery({
    queryKey: mobileQueryKeys.activeComputer(userId ?? "signed-out"),
    enabled: queryEnabled,
    queryFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("Computer unavailable.");
      return fetchActiveComputer(token);
    },
  });
  const computerName = activeComputer.data?.handle
    ?? (queryEnabled && activeComputer.isPending ? "Loading…" : "Not connected");
  const selectedComputer = activeComputer.data;
  const conversations = useQuery({
    queryKey: mobileQueryKeys.conversations(
      userId ?? "signed-out",
      selectedComputer
        ? `${selectedComputer.handle}:${selectedComputer.runtimeSlot}`
        : "none",
    ),
    enabled: queryEnabled && Boolean(selectedComputer),
    queryFn: async () => {
      const token = await getToken();
      if (!token || !selectedComputer) throw new Error("Chats unavailable.");
      return fetchConversations(token, `${HOSTED_GATEWAY_URL}${selectedComputer.gatewayPath}`);
    },
    select: (items) => [...items].sort((left, right) => right.updatedAt - left.updatedAt),
  });
  const recentChatsLoading = queryEnabled && (
    activeComputer.isPending
    || (Boolean(selectedComputer) && conversations.isPending)
  );

  return (
    <Drawer
      drawerContent={(props: DrawerContentComponentProps) => (
        <MockDrawerContent
          {...props}
          computerName={computerName}
          recentChats={conversations.data ?? []}
          recentChatsLoading={recentChatsLoading}
        />
      )}
      screenOptions={({ navigation }: { navigation: DrawerContentComponentProps["navigation"] }) => ({
        drawerPosition: "left",
        drawerType: "slide",
        drawerStyle: { width: "84%", backgroundColor: mockColors.canvas },
        overlayColor: "rgba(18, 20, 19, 0.24)",
        swipeEnabled: true,
        swipeEdgeWidth: 800,
        headerShadowVisible: false,
        headerTitleAlign: "center",
        headerStyle: { backgroundColor: mockColors.canvas },
        headerTitleStyle: { fontSize: 16 },
        headerLeft: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open navigation"
            hitSlop={10}
            onPress={() => navigation.toggleDrawer()}
            style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
          >
            <Icon
              icon={Menu01Icon}
              size={24}
              color={semanticColors.textDefault}
              testID="drawer-menu-icon"
            />
          </Pressable>
        ),
        sceneStyle: { backgroundColor: mockColors.canvas },
      })}
    >
      <Drawer.Screen name="index" options={{ title: "Matrix OS", drawerLabel: "Home" }} />
      <Drawer.Screen name="search" options={{ title: null, drawerLabel: "Search" }} />
      <Drawer.Screen name="files" options={{ title: null, drawerLabel: "Files" }} />
      <Drawer.Screen name="terminal" options={{ title: null, drawerLabel: "Terminal" }} />
      <Drawer.Screen name="integrations" options={{ title: null, drawerLabel: "Integrations" }} />
      <Drawer.Screen name="apps" options={{ title: null, drawerLabel: "Apps" }} />
      <Drawer.Screen name="settings" options={{ title: null, drawerLabel: "Settings" }} />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  menuButton: {
    marginLeft: 16,
  },
  menuButtonPressed: {
    opacity: 0.65,
  },
});
