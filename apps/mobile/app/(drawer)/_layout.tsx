import { useAuth, useOrganizationList } from "@clerk/clerk-expo";
import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard } from "react-native";
import type { LegacyPanGesture, PanGesture } from "react-native-gesture-handler";
import { useUnistyles } from "react-native-unistyles";
import { useRouter, useSegments } from "expo-router";
import {
  Drawer,
  getDrawerStatusFromState,
  useDrawerStatus,
  type DrawerContentComponentProps,
  type DrawerNavigationProp,
  type DrawerOptionsArgs,
} from "expo-router/drawer";
import type { DrawerNavigationState, ParamListBase } from "expo-router/react-navigation";

import { SidePanel } from "@/components/shell/SidePanel";
import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import { tapHaptic } from "@/lib/haptics";
import { useAgentStatuses } from "@/lib/queries/use-agent-statuses";
import { useAgents } from "@/lib/queries/use-agents";
import { useCanonicalChatPages } from "@/lib/queries/use-canonical-chats";
import { useChatSearch } from "@/lib/queries/use-chat-search";
import { useProjects } from "@/lib/queries/use-projects";
import { useSettingsSystemInfo } from "@/lib/queries/use-settings-system-info";
import { fetchCollaborationInbox } from "@/lib/requests/collaboration";
import { subscribeCollaborationDiscoveryChanged } from "@/lib/collaboration-events";
import {
  CHAT_SCREEN_HREF,
  PROJECTS_SCREEN_HREF,
  SHARED_SCREEN_HREF,
  TABS_ROUTE,
  isChatScreen,
} from "@/lib/shell-routes";
import { agentChatIds, withoutAgentChats } from "@/lib/side-panel-chats";

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

/**
 * Lets only a rightward swipe move the closed panel. The navigator's pan starts
 * on 5pt of movement either way, and it shifts a panel of this type by how far
 * past the panel's edge the touch began, which pulled the closed panel out for a
 * leftward swipe from the right edge. RNGH checks fail offsets first, so that
 * swipe now fails the pan instead.
 */
function rightwardSwipeOnly(pan: PanGesture): PanGesture {
  // react-native-drawer-layout still builds this pan with Gesture Handler's
  // legacy builder (`Gesture.Pan()`), whatever the navigator's types say.
  return (pan as unknown as LegacyPanGesture).failOffsetX(-5) as unknown as PanGesture;
}

/** What the side panel's status reads as before its state records one. */
function drawerStatus(state: DrawerNavigationState<ParamListBase>) {
  return getDrawerStatusFromState(state, "closed");
}

export default function DrawerLayout() {
  const { getToken } = useAuth();
  const router = useRouter();
  const { isLoaded: organizationsLoaded, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
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
  // Fail open while Clerk's listing is incomplete or unavailable so a real member
  // does not lose the destination because of a transient identity request. Only a
  // complete empty listing proves that this is an individual account.
  const confirmedNoOrganizations = organizationsLoaded
    && Boolean(userMemberships)
    && !userMemberships?.hasNextPage
    && !userMemberships?.isFetching
    && !userMemberships?.isError
    && userMemberships?.data.length === 0;
  const sharedAvailable = collaborationEnabled && !confirmedNoOrganizations;
  const [pendingInvitationCount, setPendingInvitationCount] = useState(0);

  // An agent's own conversation belongs to the Agents tab. Until the agents'
  // chats are known there is nothing to leave out, so every chat is listed.
  const agentChats = useMemo(() => agentChatIds(agentStatuses), [agentStatuses]);
  const chats = useMemo(() => withoutAgentChats(chatPages.chats, agentChats), [chatPages.chats, agentChats]);
  const searchResults = useMemo(() => withoutAgentChats(search.results, agentChats), [search.results, agentChats]);
  const projectCountKnown = !projects.isPending && !(projects.isError && projects.projects.length === 0);

  useEffect(() => {
    if (!sharedAvailable) return;
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
  }, [sharedAvailable]);

  return (
    <Drawer
      screenListeners={({ navigation }: { navigation: DrawerNavigationProp<ParamListBase> }) => {
        // Seed restored state without buzzing; shared state events can reach
        // multiple screens, so only an actual status change triggers feedback.
        drawerStatusRef.current ??= drawerStatus(navigation.getState());
        return {
          state: ({ data }: { data: { state: DrawerNavigationState<ParamListBase> } }) => {
            const status = drawerStatus(data.state);
            if (status !== drawerStatusRef.current) {
              drawerStatusRef.current = status;
              tapHaptic();
            }
          },
        };
      }}
      drawerContent={({ navigation }: DrawerContentComponentProps) => {
        const showChatScreen = () => {
          // Already the screen under the panel: nothing above it to close.
          router.dismissTo(CHAT_SCREEN_HREF as never);
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
              collaborationEnabled={sharedAvailable}
              pendingInvitationCount={sharedAvailable ? pendingInvitationCount : 0}
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
              onRefresh={chatPages.refresh}
              onNewChat={() => {
                startDraftChat();
                showChatScreen();
              }}
              onSelectChat={(chatId) => {
                selectChat(chatId);
                showChatScreen();
              }}
              onOpenProjects={() => {
                router.navigate(PROJECTS_SCREEN_HREF as never);
                navigation.closeDrawer();
              }}
              onOpenShared={() => {
                router.navigate(SHARED_SCREEN_HREF as never);
                navigation.closeDrawer();
              }}
            />
          </>
        );
      }}
      screenOptions={({ navigation }: DrawerOptionsArgs<ParamListBase>) => ({
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
        // An open panel keeps the leftward swipe that closes it.
        configureGestureHandler:
          drawerStatus(navigation.getState()) === "open" ? undefined : rightwardSwipeOnly,
        sceneStyle: { backgroundColor: theme.v2.colors.background },
      })}
    >
      <Drawer.Screen name={TABS_ROUTE} />
    </Drawer>
  );
}
