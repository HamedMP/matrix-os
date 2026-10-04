import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { Drawer, type DrawerContentComponentProps } from "expo-router/drawer";

import { Icon } from "@/components/ui";
import { DrawerContent } from "@/components/shell/DrawerContent";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useProjects } from "@/lib/queries/use-projects";
import { useSettingsSystemInfo } from "@/lib/queries/use-settings-system-info";
import { fetchCollaborationInbox } from "@/lib/requests/collaboration";
import { subscribeCollaborationDiscoveryChanged } from "@/lib/collaboration-events";

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
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const { computer, chats, isPending: recentChatsLoading } = useCanonicalChats();
  const { projects } = useProjects();
  const { activeChatId, selectChat, startDraftChat } = useCanonicalChatSession();
  const { systemInfo } = useSettingsSystemInfo();
  const { theme } = useUnistyles();
  const computerName = computer?.handle ?? (recentChatsLoading ? "Loading…" : "Not connected");
  const collaborationEnabled = systemInfo?.capabilities?.collaboration === true;
  const [pendingInvitationCount, setPendingInvitationCount] = useState(0);

  useEffect(() => {
    if (!collaborationEnabled) {
      setPendingInvitationCount(0);
      return;
    }
    let current = true;
    const load = () => void (async () => {
      try {
        const token = await getTokenRef.current();
        if (!token) return;
        const inbox = await fetchCollaborationInbox(token);
        if (current) setPendingInvitationCount(inbox.items.filter((item) => item.status === "invited").length);
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] invitation badge unavailable", failure instanceof Error ? failure.name : "UnknownError");
      }
    })();
    load();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(load);
    return () => { current = false; unsubscribe(); };
  }, [collaborationEnabled]);

  return (
    <Drawer
      screenListeners={{
        drawerOpen: triggerDrawerHaptic,
        drawerClose: triggerDrawerHaptic,
      }}
      drawerContent={(props: DrawerContentComponentProps) => (
        <DrawerContent
          {...props}
          computerName={computerName}
          collaborationEnabled={collaborationEnabled}
          pendingInvitationCount={pendingInvitationCount}
          recentChats={chats}
          recentChatsLoading={recentChatsLoading}
          projects={projects}
          activeSessionId={activeChatId}
          onSelectConversation={selectChat}
          onNewConversation={startDraftChat}
        />
      )}
      screenOptions={({ navigation }: { navigation: DrawerContentComponentProps["navigation"] }) => ({
        drawerPosition: "left",
        drawerType: "slide",
        drawerStyle: { width: "80%", backgroundColor: theme.v2.appColors.canvas },
        overlayColor: "rgba(18, 20, 19, 0.24)",
        swipeEnabled: true,
        swipeEdgeWidth: 800,
        headerShadowVisible: false,
        headerTitleAlign: "center",
        headerStyle: { backgroundColor: theme.v2.appColors.canvas },
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
              color={theme.v2.colors.textDefault}
              testID="drawer-menu-icon"
            />
          </Pressable>
        ),
        sceneStyle: { backgroundColor: theme.v2.appColors.canvas },
      })}
    >
      <Drawer.Screen name="index" options={{ title: null, drawerLabel: "Home" }} />
      <Drawer.Screen name="files" options={{ title: null, drawerLabel: "Files" }} />
      <Drawer.Screen name="terminal" options={{ title: null, drawerLabel: "Terminal" }} />
      <Drawer.Screen name="integrations" options={{ title: null, drawerLabel: "Integrations" }} />
      <Drawer.Screen name="apps" options={{ title: null, drawerLabel: "Apps" }} />
      {collaborationEnabled
        ? <Drawer.Screen name="shared" options={{ title: null, drawerLabel: "Shared with me" }} />
        : null}
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
