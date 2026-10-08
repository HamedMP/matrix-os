import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useRef, useState } from "react";
import { useUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useSegments } from "expo-router";
import { Drawer, type DrawerContentComponentProps } from "expo-router/drawer";

import { DrawerContent } from "@/components/shell/DrawerContent";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useCanonicalChats } from "@/lib/queries/use-canonical-chats";
import { useProjects } from "@/lib/queries/use-projects";
import { useSettingsSystemInfo } from "@/lib/queries/use-settings-system-info";
import { fetchCollaborationInbox } from "@/lib/requests/collaboration";
import { subscribeCollaborationDiscoveryChanged } from "@/lib/collaboration-events";
import { TABS_ROUTE, isChatScreen } from "@/lib/shell-routes";

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
  // The side panel belongs to the chat screen: it lists chats and projects, and
  // every other screen keeps the swipe for its own lists and for going back.
  const chatScreenFocused = isChatScreen(useSegments());
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
          chatScreenFocused={chatScreenFocused}
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
      screenOptions={{
        headerShown: false,
        drawerPosition: "left",
        drawerType: "slide",
        drawerStyle: { width: "80%", backgroundColor: theme.v2.appColors.canvas },
        overlayColor: "rgba(18, 20, 19, 0.24)",
        swipeEnabled: chatScreenFocused,
        swipeEdgeWidth: 800,
        sceneStyle: { backgroundColor: theme.v2.appColors.canvas },
      }}
    >
      <Drawer.Screen name={TABS_ROUTE} />
    </Drawer>
  );
}
