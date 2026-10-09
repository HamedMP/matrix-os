import { useAuth } from "@clerk/clerk-expo";
import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { useSegments } from "expo-router";
import {
  Drawer,
  getDrawerStatusFromState,
  useDrawerStatus,
  type DrawerContentComponentProps,
} from "expo-router/drawer";

import { SidePanel } from "@/components/shell/SidePanel";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents } from "@/lib/queries/use-agents";
import { useCanonicalChatPages } from "@/lib/queries/use-canonical-chats";
import { useChatSearch } from "@/lib/queries/use-chat-search";
import { useProjects } from "@/lib/queries/use-projects";
import { useSettingsSystemInfo } from "@/lib/queries/use-settings-system-info";
import { fetchCollaborationInbox } from "@/lib/requests/collaboration";
import { subscribeCollaborationDiscoveryChanged } from "@/lib/collaboration-events";
import {
  TABS_ROUTE,
  chatScreenParams,
  isChatScreen,
  projectsScreenParams,
  sharedScreenParams,
} from "@/lib/shell-routes";
import { agentChatIds, withoutAgentChats } from "@/lib/side-panel-chats";

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

/**
 * Puts the keyboard away when the panel closes. The search field keeps it up
 * while it has focus, and the navigator dismisses it for a swipe only: not for
 * a press on a row or on the scrim.
 */
function DismissKeyboardOnClose() {
  const status = useDrawerStatus();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status === "open") {
      wasOpen.current = true;
    } else if (wasOpen.current) {
      wasOpen.current = false;
      Keyboard.dismiss();
    }
  }, [status]);
  return null;
}

export default function DrawerLayout() {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const drawerStatusRef = useRef<ReturnType<typeof getDrawerStatusFromState> | null>(null);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const chatPages = useCanonicalChatPages();
  const projects = useProjects();
  const { agents } = useAgents();
  const { statuses: agentStatuses } = useAgentStatuses(agents);
  const [searchQuery, setSearchQuery] = useState("");
  const search = useChatSearch(searchQuery);
  const { selectChat, startDraftChat } = useCanonicalChatSession();
  const { systemInfo } = useSettingsSystemInfo();
  const { theme } = useUnistyles();
  // The side panel belongs to the chat screen: it lists chats and projects, and
  // every other screen keeps the swipe for its own lists and for going back.
  const chatScreenFocused = isChatScreen(useSegments());
  const collaborationEnabled = systemInfo?.capabilities?.collaboration === true;
  const [pendingInvitationCount, setPendingInvitationCount] = useState(0);

  // An agent's own conversation belongs to the Agents tab. Until the agents'
  // chats are known there is nothing to leave out, so every chat is listed.
  const agentChats = useMemo(() => agentChatIds(agentStatuses), [agentStatuses]);
  const chats = useMemo(() => withoutAgentChats(chatPages.chats, agentChats), [chatPages.chats, agentChats]);
  const searchResults = useMemo(() => withoutAgentChats(search.results, agentChats), [search.results, agentChats]);
  const projectCountKnown = !projects.isPending && !(projects.isError && projects.projects.length === 0);

  useEffect(() => {
    if (!collaborationEnabled) return;
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
      screenListeners={({ navigation }) => {
        // Seed restored state without buzzing; shared state events can reach
        // multiple screens, so only an actual status change triggers feedback.
        drawerStatusRef.current ??= getDrawerStatusFromState(navigation.getState());
        return {
          state: ({ data }) => {
            const status = getDrawerStatusFromState(data.state);
            if (status !== drawerStatusRef.current) {
              drawerStatusRef.current = status;
              triggerDrawerHaptic();
            }
          },
        };
      }}
      drawerContent={({ navigation }: DrawerContentComponentProps) => {
        const showChatScreen = () => {
          navigation.navigate(TABS_ROUTE, chatScreenParams());
          navigation.closeDrawer();
        };
        return (
          <>
            <DismissKeyboardOnClose />
            <SidePanel
              chats={chats}
              chatsLoading={chatPages.isPending}
              chatsFailed={chatPages.isError}
              projectCount={projectCountKnown ? projects.projects.length : undefined}
              collaborationEnabled={collaborationEnabled}
              pendingInvitationCount={collaborationEnabled ? pendingInvitationCount : 0}
              searchQuery={searchQuery}
              searchResults={searchResults}
              searching={search.isSearching}
              searchFailed={search.isError}
              loadingMore={chatPages.isLoadingMore}
              loadMoreFailed={chatPages.isLoadMoreError}
              onSearchQueryChange={setSearchQuery}
              onLoadMore={() => {
                if (chatPages.hasMore && !chatPages.isLoadingMore) void chatPages.loadMore();
              }}
              onNewChat={() => {
                startDraftChat();
                showChatScreen();
              }}
              onSelectChat={(chatId) => {
                selectChat(chatId);
                showChatScreen();
              }}
              onOpenProjects={() => {
                navigation.navigate(TABS_ROUTE, projectsScreenParams());
                navigation.closeDrawer();
              }}
              onOpenShared={() => {
                navigation.navigate(TABS_ROUTE, sharedScreenParams());
                navigation.closeDrawer();
              }}
            />
          </>
        );
      }}
      screenOptions={{
        headerShown: false,
        drawerPosition: "left",
        // The panel slides over the screen, which stays where it is under the scrim.
        drawerType: "front",
        drawerStyle: {
          width: theme.v2.size.sidePanel,
          backgroundColor: theme.v2.colors.background,
          boxShadow: theme.v2.designShadows.panel,
          // The navigator rounds the open edge of a panel of this type by default.
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        },
        overlayColor: theme.v2.colors.scrim,
        overlayAccessibilityLabel: "Close side panel",
        swipeEnabled: chatScreenFocused,
        swipeEdgeWidth: 800,
        sceneStyle: { backgroundColor: theme.v2.colors.background },
      }}
    >
      <Drawer.Screen name={TABS_ROUTE} />
    </Drawer>
  );
}
