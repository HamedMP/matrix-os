import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import { Pressable, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { Drawer, type DrawerContentComponentProps } from "expo-router/drawer";

import { Icon } from "@/components/ui";
import { MockDrawerContent } from "@/components/mock-shell/MockDrawerContent";
import { mockColors } from "@/components/mock-shell/theme";
import { useChatSession } from "@/lib/chat-session-context";
import { useComputerConversations } from "@/lib/queries/use-computer-conversations";
import { semanticColors } from "@/lib/theme";

function triggerDrawerHaptic() {
  void Promise.resolve(
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  ).catch((error: unknown) => {
    console.warn(
      "[mobile] drawer haptic unavailable",
      error instanceof Error ? error.name : "unknown",
    );
  });
}

export default function DrawerLayout() {
  const { computer, conversations, isPending: recentChatsLoading } = useComputerConversations();
  const { activeSessionId, selectConversation, startDraftConversation } = useChatSession();
  const computerName = computer?.handle ?? (recentChatsLoading ? "Loading…" : "Not connected");

  return (
    <Drawer
      screenListeners={{
        drawerOpen: triggerDrawerHaptic,
        drawerClose: triggerDrawerHaptic,
      }}
      drawerContent={(props: DrawerContentComponentProps) => (
        <MockDrawerContent
          {...props}
          computerName={computerName}
          recentChats={conversations}
          recentChatsLoading={recentChatsLoading}
          activeSessionId={activeSessionId}
          onSelectConversation={selectConversation}
          onNewConversation={startDraftConversation}
        />
      )}
      screenOptions={({ navigation }: { navigation: DrawerContentComponentProps["navigation"] }) => ({
        drawerPosition: "left",
        drawerType: "slide",
        drawerStyle: { width: "80%", backgroundColor: mockColors.canvas },
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
      <Drawer.Screen name="index" options={{ title: null, drawerLabel: "Home" }} />
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
