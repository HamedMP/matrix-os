import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useGlobalSearchParams, useNavigationContainerRef, useRouter, useSegments } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import type { MatrixComputer } from "@matrix-os/contracts";
import { RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS } from "@matrix-os/contracts/runtime-lifecycle";

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
  chatExists,
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
const CHAT_TAP_LOOKUP_TIMEOUT_MS = 10_000;

function isChatOnScreen(segments: readonly string[]): boolean {
  return isChatScreen(segments)
    || (isChatScreen(segments.slice(0, 3)) && segments.slice(3).join("/") === PROJECT_CHAT);
}

function hostedGatewayUrl(computer: MatrixComputer): string {
  return `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`;
}

function warn(scope: string, err: unknown) {
  console.warn(`[mobile] ${scope}:`, err instanceof Error ? err.message : "unknown");
}

/**
 * Whether the chat is on the computer. Only the computer's own answer that it
 * has no such chat counts against it: when it cannot be asked, the chat opens
 * and its screen reports the failed connection.
 */
async function isChatOnComputer(session: GatewaySession, chatId: string): Promise<boolean> {
  try {
    return await chatExists(session.getToken ?? session.token, session.gatewayUrl, chatId, CHAT_TAP_LOOKUP_TIMEOUT_MS);
  } catch (err: unknown) {
    warn("Notification chat lookup failed", err);
    return true;
  }
}

interface NotificationRouterProps {
  /** Whether the app can reach a computer: not while signed out of a hosted one. */
  connected: boolean;
  setGateway: (gateway: GatewayConnection) => void;
}

/**
 * Opens what a tapped notification is about, whether the tap launched the app
 * or reached it while running, and keeps notifications about the chat or
 * thread on screen from showing while the app is open.
 */
export function NotificationRouter({ connected, setGateway }: NotificationRouterProps) {
  const navigation = useNavigationContainerRef();
  const router = useRouter();
  const segments = useSegments();
  const { session: sessionParam } = useGlobalSearchParams<{ session?: string | string[] }>();
  const queryClient = useQueryClient();
  const { activeChatId, selectChat } = useCanonicalChatSession();
  const { computer, session: gatewaySession, userId, isComputerPending } = useActiveGateway();
  const handle = computer?.handle ?? null;

  const screen = useMemo<NotificationScreen | null>(() => {
    if (activeChatId && isChatOnScreen(segments)) return { kind: "chat", handle, chatId: activeChatId };
    const session = [sessionParam].flat()[0];
    if (segments[0] === "terminal-session" && session) return { kind: "terminal", handle, session };
    return null;
  }, [activeChatId, segments, sessionParam, handle]);

  const screenRef = useRef(screen);
  const gatewaySessionRef = useRef(gatewaySession);
  // Read after a lookup, by when another chat may have been chosen.
  const activeChatIdRef = useRef(activeChatId);
  useEffect(() => {
    screenRef.current = screen;
    gatewaySessionRef.current = gatewaySession;
    activeChatIdRef.current = activeChatId;
  });

  useEffect(() => {
    Notifications.setNotificationHandler(createNotificationHandler({
      screen: () => screenRef.current,
      threadTerminal: async (threadId) => {
        const session = await gatewaySessionRef.current();
        if (!session) return null;
        return fetchThreadTerminalSession(session.getToken ?? session.token, session.gatewayUrl, threadId, FOREGROUND_LOOKUP_TIMEOUT_MS);
      },
    }));
    return () => Notifications.setNotificationHandler(defaultNotificationHandler);
  }, []);

  // The last computer switch a tap started. A switch cannot be taken back once
  // its save begins, so it runs to the end and later taps wait for it.
  const switchingRef = useRef<Promise<void> | null>(null);

  /**
   * The computer a notification came from, switched to first when another one
   * is on screen. Only the latest tap starts a switch, and a tap reads which
   * computer is on screen only once an earlier tap's switch has finished.
   */
  const gatewayFor = useCallback(async (wanted: string | null, isLatest: () => boolean): Promise<GatewaySession | null> => {
    await Promise.allSettled([switchingRef.current]);
    // Read now rather than from this render, which a switch since may have outdated.
    const current = queryClient.getQueryData<MatrixComputer | null>(mobileQueryKeys.activeComputer(userId)) ?? null;
    const session = current ? await gatewaySession() : null;
    if (!current || !session?.token) return null;
    if (wanted === null || wanted === current.handle) return { ...session, gatewayUrl: hostedGatewayUrl(current) };
    const inventory = await fetchComputers(session.token);
    const matches = inventory.items.filter((computer) => computer.handle === wanted);
    // The account's own choice of computer outranks the phone's.
    if (matches.length !== 1 || (inventory.selectedSlot ?? matches[0].runtimeSlot) !== matches[0].runtimeSlot) {
      return null;
    }
    if (!isLatest()) return null;
    const switching = (async () => {
      setGateway(await saveSelectedHostedComputer(matches[0]));
      await queryClient.invalidateQueries({ queryKey: mobileQueryKeys.activeComputer(userId) });
    })();
    switchingRef.current = switching;
    await switching;
    return { ...session, gatewayUrl: hostedGatewayUrl(matches[0]) };
  }, [gatewaySession, userId, queryClient, setGateway]);

  /**
   * Opens a tap's destination. Each lookup can be slow, so after every one a
   * tap that a later tap has replaced stops without changing anything.
   */
  const open = useCallback(async ({ handle: wanted, target }: NotificationDestination, isLatest: () => boolean) => {
    const showChatList = () => {
      if (isLatest()) showChatListFromRoot(navigation, router);
    };
    try {
      const session = await gatewayFor(wanted, isLatest);
      if (!session || !target) {
        showChatList();
        return;
      }
      if (target.type === "chat") {
        // A push that does not name its computer may be about another one.
        const onComputer = await isChatOnComputer(session, target.chatId);
        if (!isLatest()) return;
        if (!onComputer) {
          showChatList();
          return;
        }
        // Choosing the open chat again would drop the model picked for it.
        if (target.chatId !== activeChatIdRef.current) selectChat(target.chatId);
        showChatScreenFromRoot(navigation, router);
        return;
      }
      const requestToken = session.getToken ?? session.token;
      const terminal = await fetchThreadTerminalSession(
        requestToken, session.gatewayUrl, target.threadId, RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
      );
      if (!isLatest()) return;
      // A chat's own terminal is not listed: it attaches only with that chat's context.
      const listed = terminal !== null
        && (await fetchTerminalSessions(requestToken, session.gatewayUrl)).some((tab) => tab.id === terminal);
      if (!isLatest()) return;
      if (terminal !== null && listed) openTerminalFromRoot(navigation, router, terminal);
      else showChatList();
    } catch (err: unknown) {
      warn("Notification could not be opened", err);
      showChatList();
    }
  }, [gatewayFor, navigation, router, selectChat]);

  // The latest tap not yet opened. The same tap can arrive twice on a launch:
  // from the listener and as the launch's last response.
  const pendingRef = useRef<Notifications.NotificationResponse | null>(null);
  const lastTapRef = useRef<string | null>(null);
  // Counts the taps being opened; only the latest may still change the screen.
  const openingRef = useRef(0);
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
    try {
      const launchTap = Notifications.getLastNotificationResponse();
      if (launchTap) receive(launchTap);
    } catch (err: unknown) {
      warn("Launch notification unavailable", err);
    }
    return () => subscription.remove();
  }, [receive]);

  // The sign-in gate and the journey gate answer at `/`, which has no segment.
  // A link can show the shell while signed out, so the tap also waits for a
  // connection rather than being spent on the chat list.
  const ready = connected && segments.length > 0 && !BEFORE_SHELL.has(segments[0]) && !isComputerPending;

  useEffect(() => {
    const response = pendingRef.current;
    if (!ready || !response) return;
    pendingRef.current = null;
    // Opened once: the next launch does not open it again.
    try {
      Notifications.clearLastNotificationResponse();
    } catch (err: unknown) {
      warn("Launch notification not cleared", err);
    }
    const opening = ++openingRef.current;
    void open(
      parseNotificationDestination(response.notification.request.content.data),
      () => opening === openingRef.current,
    );
  }, [ready, taps, open]);

  return null;
}
