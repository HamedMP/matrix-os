import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useGlobalSearchParams, useNavigationContainerRef, useRouter, useSegments } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { useCanonicalChatSession } from "@/lib/canonical-chat-session-context";
import {
  openTerminalFromRoot,
  showChatListFromRoot,
  showChatScreenFromRoot,
} from "@/lib/notification-navigation";
import {
  addNotificationResponseListener,
  createNotificationHandler,
  defaultNotificationHandler,
  isNotificationTap,
  parseNotificationDestination,
  type NotificationDestination,
  type NotificationScreen,
} from "@/lib/push";
import { useActiveGateway, type GatewaySession } from "@/lib/queries/use-active-gateway";
import {
  fetchComputers,
  fetchTerminalSessions,
  fetchThreadTerminalSession,
  mobileQueryKeys,
} from "@/lib/requests";
import { isChatScreen } from "@/lib/shell-routes";
import { HOSTED_GATEWAY_URL, saveSelectedHostedComputer, type GatewayConnection } from "@/lib/storage";

/** Screens shown before the shell. A tap waits for the shell, or the sign-in gate would replace what it opened. */
const BEFORE_SHELL = new Set(["sign-in", "sign-in-computer"]);
/** A chat opened from a project, in the Chats tab above the chat screen. */
const PROJECT_CHAT = "projects/[projectId]/chats/[chatId]";
/** Expo answers for the app after three seconds, so the foreground check stops sooner. */
const FOREGROUND_LOOKUP_TIMEOUT_MS = 1_500;
const TAP_LOOKUP_TIMEOUT_MS = 10_000;

function isChatOnScreen(segments: readonly string[]): boolean {
  return isChatScreen(segments)
    || (isChatScreen(segments.slice(0, 3)) && segments.slice(3).join("/") === PROJECT_CHAT);
}

function warn(scope: string, err: unknown) {
  console.warn(`[mobile] ${scope}:`, err instanceof Error ? err.message : "unknown");
}

/**
 * Opens what a tapped notification is about, whether the tap launched the app
 * or reached it while running, and keeps notifications about the chat or
 * thread on screen from showing while the app is open.
 */
export function NotificationRouter({ setGateway }: { setGateway: (gateway: GatewayConnection) => void }) {
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  const segments = useSegments();
  const { session: sessionParam } = useGlobalSearchParams<{ session?: string | string[] }>();
  const queryClient = useQueryClient();
  const { activeChatId, selectChat } = useCanonicalChatSession();
  const gateway = useActiveGateway();
  const handle = gateway.computer?.handle ?? null;

  const screen = useMemo<NotificationScreen | null>(() => {
    if (activeChatId && isChatOnScreen(segments)) return { kind: "chat", handle, chatId: activeChatId };
    const session = [sessionParam].flat()[0];
    if (segments[0] === "terminal-session" && session) return { kind: "terminal", handle, session };
    return null;
  }, [activeChatId, segments, sessionParam, handle]);

  const screenRef = useRef(screen);
  const gatewaySessionRef = useRef(gateway.session);
  useEffect(() => {
    screenRef.current = screen;
    gatewaySessionRef.current = gateway.session;
  });

  useEffect(() => {
    Notifications.setNotificationHandler(createNotificationHandler({
      screen: () => screenRef.current,
      threadTerminal: async (threadId) => {
        const session = await gatewaySessionRef.current();
        if (!session) return null;
        return fetchThreadTerminalSession(session.token, session.gatewayUrl, threadId, FOREGROUND_LOOKUP_TIMEOUT_MS);
      },
    }));
    return () => Notifications.setNotificationHandler(defaultNotificationHandler);
  }, []);

  /** The computer a notification came from, switched to first when another one is on screen. */
  const gatewayFor = useCallback(async (wanted: string | null): Promise<GatewaySession | null> => {
    const current = gateway.computer;
    const session = current ? await gateway.session() : null;
    if (!current || !session) return null;
    if (wanted === null || wanted === current.handle) return session;
    const inventory = await fetchComputers(session.token);
    const matches = inventory.items.filter((computer) => computer.handle === wanted);
    // The account's own choice of computer outranks the phone's.
    if (matches.length !== 1 || (inventory.selectedSlot ?? matches[0].runtimeSlot) !== matches[0].runtimeSlot) {
      return null;
    }
    setGateway(await saveSelectedHostedComputer(matches[0]));
    await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.activeComputer(gateway.userId) });
    return { token: session.token, gatewayUrl: `${HOSTED_GATEWAY_URL}${matches[0].gatewayPath}` };
  }, [gateway, queryClient, setGateway]);

  const open = useCallback(async ({ handle: wanted, target }: NotificationDestination) => {
    try {
      const session = await gatewayFor(wanted);
      if (!session || !target) {
        showChatListFromRoot(navigation, router);
        return;
      }
      if (target.type === "chat") {
        // Choosing the open chat again would drop the model picked for it.
        if (target.chatId !== activeChatId) selectChat(target.chatId);
        showChatScreenFromRoot(navigation, router);
        return;
      }
      const terminal = await fetchThreadTerminalSession(
        session.token, session.gatewayUrl, target.threadId, TAP_LOOKUP_TIMEOUT_MS,
      );
      // A chat's own terminal is not listed: it attaches only with that chat's context.
      const listed = terminal !== null
        && (await fetchTerminalSessions(session.token, session.gatewayUrl)).some((tab) => tab.id === terminal);
      if (terminal !== null && listed) openTerminalFromRoot(navigation, router, terminal);
      else showChatListFromRoot(navigation, router);
    } catch (err: unknown) {
      warn("Notification could not be opened", err);
      showChatListFromRoot(navigation, router);
    }
  }, [gatewayFor, navigation, router, activeChatId, selectChat]);

  // The latest tap not yet opened. The same tap can arrive twice on a launch:
  // from the listener and as the launch's last response.
  const pendingRef = useRef<Notifications.NotificationResponse | null>(null);
  const lastTapRef = useRef<string | null>(null);
  const [taps, countTap] = useReducer((count: number) => count + 1, 0);

  const receive = useCallback((response: Notifications.NotificationResponse) => {
    if (!isNotificationTap(response)) return;
    const id = response.notification.request.identifier;
    if (id === lastTapRef.current) return;
    lastTapRef.current = id;
    pendingRef.current = response;
    countTap();
  }, []);

  useEffect(() => {
    const subscription = addNotificationResponseListener(receive);
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) receive(response);
      })
      .catch((err: unknown) => warn("Launch notification unavailable", err));
    return () => subscription.remove();
  }, [receive]);

  const ready = segments.length > 0 && !BEFORE_SHELL.has(segments[0]) && !gateway.isComputerPending;

  useEffect(() => {
    const response = pendingRef.current;
    if (!ready || !response) return;
    pendingRef.current = null;
    // Opened once: the next launch does not open it again.
    Notifications.clearLastNotificationResponseAsync()
      .catch((err: unknown) => warn("Launch notification not cleared", err));
    void open(parseNotificationDestination(response.notification.request.content.data));
  }, [ready, taps, open]);

  return null;
}
