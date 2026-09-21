import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@clerk/clerk-expo";
import {
  CollaborationDiscoveryItemSchema,
  CollaborationEventFrameSchema,
  CollaborationInvitationSchema,
  CollaborationScopeSchema,
  CollaborationSharedChatMessageSchema,
  CollaborationChatSchema,
  CollaborationAiRequestsResponseSchema,
  type CollaborationAiRequest,
  type CollaborationApproval,
} from "@matrix-os/contracts/collaboration";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View,
  type ListRenderItemInfo } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { z } from "zod/v4";
import { renderChatMarkdown, type ChatMarkdownTheme } from "@/lib/chat-markdown";
import { loadCollaborationDraft, saveCollaborationDraft } from "@/lib/collaboration-drafts";
import { notifyCollaborationDiscoveryChanged } from "@/lib/collaboration-events";
import { SharedChatComposer } from "@/components/collaboration/SharedChatComposer";
import { canControlSharedAiRequest } from "@/components/collaboration/shared-chat-composer-model";
import { SessionDiscussionSheet } from "@/components/collaboration/SessionDiscussionSheet";
import { SessionAccessControl } from "@/components/collaboration/SessionAccessControl";
import { SharedTerminalScreen } from "@/components/collaboration/SharedTerminalScreen";
import { SharedProjectScreen } from "@/components/collaboration/SharedProjectScreen";
import { CollaborationRecoverySupersededError } from "@/components/collaboration/useSharedProjectWorkflow";
import {
  acceptCollaborationInvitation,
  declineCollaborationInvitation,
  collaborationEventsUrl,
  fetchCollaborationInbox,
  fetchCollaborationInvitation,
  fetchCollaborationEventTicket,
  fetchCollaborationScope,
  fetchSharedChat,
  fetchSharedChatMessages,
  fetchSharedAiRequests,
  fetchSharedCollaborations,
  postSharedAiRequest,
  controlSharedAiRequest,
  decideSharedAiApproval,
  updateSharedChatReadState,
} from "@/lib/requests/collaboration";

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
type Invitation = z.infer<typeof CollaborationInvitationSchema>;
type Scope = z.infer<typeof CollaborationScopeSchema>;
type Chat = z.infer<typeof CollaborationChatSchema>;
type Message = z.infer<typeof CollaborationSharedChatMessageSchema>;
type ViewState = { kind: "home" } | { kind: "invitation"; invitation: Invitation }
  | { kind: "chat"; scopeId: string } | { kind: "terminal"; scopeId: string }
  | { kind: "project"; scopeId: string };
type ScreenState = {
  view: ViewState;
  items: DiscoveryItem[];
  inboxCursor: string | null;
  sharedCursor: string | null;
  loadingMoreItems: boolean;
  paginationError: string;
  scope: Scope | null;
  chat: Chat | null;
  messages: Message[];
  hasMoreMessages: boolean;
  loadingMoreMessages: boolean;
  aiDraft: string;
  aiAvailability: "checking" | "available" | "unavailable" | "owner_reconnect_required";
  aiRequests: CollaborationAiRequest[];
  approvals: CollaborationApproval[];
  aiError: string;
  loading: boolean;
  sending: boolean;
  error: string;
};

const initialState: ScreenState = {
  view: { kind: "home" },
  items: [],
  inboxCursor: null,
  sharedCursor: null,
  loadingMoreItems: false,
  paginationError: "",
  scope: null,
  chat: null,
  messages: [],
  hasMoreMessages: false,
  loadingMoreMessages: false,
  aiDraft: "",
  aiAvailability: "checking",
  aiRequests: [],
  approvals: [],
  aiError: "",
  loading: true,
  sending: false,
  error: "",
};

function sharedAiAvailability(
  status: "available" | "unavailable" | "owner_binding_required" | "owner_reconnect_required",
): ScreenState["aiAvailability"] {
  if (status === "available" || status === "owner_reconnect_required") return status;
  return "unavailable";
}

type ScreenAction =
  | { type: "patch"; patch: Partial<ScreenState> }
  | { type: "ai_request_accepted"; scopeId: string; chatId: string; request: CollaborationAiRequest; resourceRevision: string }
  | { type: "ai_refresh_failed"; retainQueue: boolean }
  | { type: "append_items"; additions: DiscoveryItem[]; inboxCursor?: string | null; sharedCursor?: string | null };

function screenReducer(state: ScreenState, action: ScreenAction): ScreenState {
  if (action.type === "patch") return { ...state, ...action.patch };
  if (action.type === "ai_refresh_failed") {
    // Keep the last confirmed readiness: retain an available queue with a notice,
    // and never promote or degrade an owner reconnect requirement.
    return {
      ...state,
      aiAvailability: action.retainQueue ? "available"
        : state.aiAvailability === "owner_reconnect_required" ? "owner_reconnect_required" : "unavailable",
      ...(action.retainQueue ? { aiError: "Queue updates are delayed. The last confirmed order is shown." } : {}),
    };
  }
  if (action.type === "ai_request_accepted") {
    if (state.view.kind !== "chat" || state.view.scopeId !== action.scopeId || state.chat?.id !== action.chatId) return state;
    return {
      ...state,
      chat: { ...state.chat, revision: action.resourceRevision },
      aiDraft: "",
      aiRequests: [...state.aiRequests.filter((candidate) => candidate.id !== action.request.id), action.request]
        .sort(compareAcceptedSequence),
    };
  }
  const items = action.additions.reduce<DiscoveryItem[]>((combined, item) => (
    combined.some((existing) => discoveryKey(existing) === discoveryKey(item)) ? combined : [...combined, item]
  ), state.items);
  return {
    ...state,
    items,
    ...(action.inboxCursor === undefined ? {} : { inboxCursor: action.inboxCursor }),
    ...(action.sharedCursor === undefined ? {} : { sharedCursor: action.sharedCursor }),
  };
}

export default function SharedScreen() {
  const { getToken, userId } = useAuth();
  const getTokenRef = useRef(getToken);
  useEffect(() => { getTokenRef.current = getToken; }, [getToken]);
  const { theme } = useUnistyles();
  const [state, dispatch] = useReducer(screenReducer, initialState);
  const { view, inboxCursor, sharedCursor, loadingMoreItems, scope, chat, messages,
    loadingMoreMessages } = state;
  const chatLoadGeneration = useRef(0);
  const latestSequenceRef = useRef("0");
  const eventSequenceRef = useRef("0");
  const eventScopeRef = useRef<string | null>(null);
  const aiWasAvailableRef = useRef(false);
  const chatRef = useRef<Chat | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const token = useCallback(async () => {
    const value = await getTokenRef.current();
    if (!value) throw new Error("CollaborationUnavailable");
    return value;
  }, []);
  const loadHome = useCallback(async () => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try {
      const actorToken = await token();
      const [inbox, shared] = await Promise.all([
        fetchCollaborationInbox(actorToken), fetchSharedCollaborations(actorToken),
      ]);
      dispatch({ type: "patch", patch: {
        items: [...inbox.items, ...shared.items],
        inboxCursor: inbox.nextCursor ?? null,
        sharedCursor: shared.nextCursor ?? null,
        paginationError: "",
      } });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discovery failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Shared Chats are unavailable. Pull down or return later to try again." } });
    } finally { dispatch({ type: "patch", patch: { loading: false } }); }
  }, [token]);
  useEffect(() => { void loadHome(); }, [loadHome]);
  const loadMoreItems = async () => {
    if (loadingMoreItems || (!inboxCursor && !sharedCursor)) return;
    dispatch({ type: "patch", patch: { loadingMoreItems: true, paginationError: "" } });
    try {
      const actorToken = await token();
      const [inbox, shared] = await Promise.all([
        inboxCursor ? fetchCollaborationInbox(actorToken, inboxCursor) : null,
        sharedCursor ? fetchSharedCollaborations(actorToken, sharedCursor) : null,
      ]);
      const additions = [...(inbox?.items ?? []), ...(shared?.items ?? [])];
      dispatch({ type: "append_items", additions,
        ...(inbox ? { inboxCursor: inbox.nextCursor ?? null } : {}),
        ...(shared ? { sharedCursor: shared.nextCursor ?? null } : {}),
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] discovery page failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { paginationError: "More shared items could not be loaded. Try again." } });
    } finally { dispatch({ type: "patch", patch: { loadingMoreItems: false } }); }
  };
  const loadChat = useCallback(async (scopeId: string) => {
    const generation = ++chatLoadGeneration.current;
    if (eventScopeRef.current !== scopeId) {
      eventScopeRef.current = scopeId;
      eventSequenceRef.current = "0";
      latestSequenceRef.current = "0";
      chatRef.current = null;
      messagesRef.current = [];
      aiWasAvailableRef.current = false;
    }
    dispatch({ type: "patch", patch: {
      loading: true,
      error: "",
      view: { kind: "chat", scopeId },
      scope: null,
      chat: null,
      messages: [],
      aiDraft: "",
      aiAvailability: "checking",
      aiRequests: [],
      approvals: [],
      aiError: "",
      sending: false,
      hasMoreMessages: false,
      loadingMoreMessages: false,
    } });
    try {
      const actorToken = await token();
      const [nextScope, nextChat, history] = await Promise.all([
        fetchCollaborationScope(actorToken, scopeId),
        fetchSharedChat(actorToken, scopeId),
        fetchSharedChatMessages(actorToken, scopeId),
      ]);
      const nextAiDraft = await loadCollaborationDraft(
        AsyncStorage,
        { actorId: userId, scopeId, chatId: nextChat.id, mode: "ai" },
      );
      if (generation !== chatLoadGeneration.current) return;
      chatRef.current = nextChat;
      messagesRef.current = history.messages;
      latestSequenceRef.current = history.messages.at(-1)?.sequence ?? "0";
      dispatch({ type: "patch", patch: {
        scope: nextScope,
        chat: nextChat,
        messages: history.messages,
        hasMoreMessages: BigInt(nextChat.messageCount) > BigInt(history.messages.length),
        aiDraft: nextAiDraft,
      } });
      try {
        const ai = CollaborationAiRequestsResponseSchema.parse(await fetchSharedAiRequests(actorToken, scopeId));
        if (generation === chatLoadGeneration.current) {
          aiWasAvailableRef.current = ai.capability.status === "available";
          const refreshedChat = { ...nextChat, revision: ai.resourceRevision };
          chatRef.current = refreshedChat;
          dispatch({ type: "patch", patch: {
            aiAvailability: sharedAiAvailability(ai.capability.status),
            aiRequests: ai.requests, approvals: ai.approvals,
            aiError: "", chat: refreshedChat,
          } });
        }
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] shared AI unavailable", failure instanceof Error ? failure.name : "UnknownError");
        if (generation === chatLoadGeneration.current) dispatch({ type: "patch", patch: { aiAvailability: "unavailable" } });
      }
      const sequence = history.messages.at(-1)?.sequence;
      if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
        console.warn("[mobile-collaboration] read state failed", failure instanceof Error ? failure.name : "UnknownError");
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] Chat load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { error: "This shared Chat is unavailable. Your access may have changed." } });
      }
    } finally {
      if (generation === chatLoadGeneration.current) dispatch({ type: "patch", patch: { loading: false } });
    }
  }, [token, userId]);
  const loadMoreMessages = async () => {
    if (view.kind !== "chat" || !chat || loadingMoreMessages) return;
    const after = messages.at(-1)?.sequence;
    if (!after) return;
    const generation = chatLoadGeneration.current;
    dispatch({ type: "patch", patch: { loadingMoreMessages: true, error: "" } });
    try {
      const page = await fetchSharedChatMessages(await token(), view.scopeId, after);
      if (generation !== chatLoadGeneration.current) return;
      const currentChat = chatRef.current;
      if (!currentChat) return;
      const currentMessages = messagesRef.current;
      const appended = page.messages.filter((message) => !currentMessages.some((existing) => existing.id === message.id));
      const combined = [...currentMessages, ...appended];
      messagesRef.current = combined;
      latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
      dispatch({ type: "patch", patch: {
        messages: combined,
        hasMoreMessages: appended.length > 0 && BigInt(currentChat.messageCount) > BigInt(combined.length),
      } });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] history page failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { error: "More messages could not be loaded. Try again." } });
      }
    } finally {
      if (generation === chatLoadGeneration.current) {
        dispatch({ type: "patch", patch: { loadingMoreMessages: false } });
      }
    }
  };
  const refreshLiveChat = useCallback(async (scopeId: string) => {
    const generation = ++chatLoadGeneration.current;
    const actorToken = await token();
    const [nextScope, nextChat] = await Promise.all([
      fetchCollaborationScope(actorToken, scopeId),
      fetchSharedChat(actorToken, scopeId),
    ]);
    let combined = messagesRef.current;
    const targetCount = BigInt(nextChat.messageCount);
    while (BigInt(combined.length) < targetCount) {
      const page = await fetchSharedChatMessages(actorToken, scopeId, combined.at(-1)?.sequence ?? "0");
      const additions = page.messages.filter((message) => !combined.some((existing) => existing.id === message.id));
      if (additions.length === 0) throw new Error("CollaborationRecoveryIncomplete");
      combined = [...combined, ...additions];
    }
    if (generation !== chatLoadGeneration.current || eventScopeRef.current !== scopeId) {
      throw new CollaborationRecoverySupersededError();
    }
    chatRef.current = nextChat;
    messagesRef.current = combined;
    latestSequenceRef.current = combined.at(-1)?.sequence ?? latestSequenceRef.current;
    dispatch({ type: "patch", patch: {
      scope: nextScope,
      chat: nextChat,
      messages: combined,
      hasMoreMessages: BigInt(nextChat.messageCount) > BigInt(combined.length),
      loading: false,
    } });
    try {
      const ai = CollaborationAiRequestsResponseSchema.parse(await fetchSharedAiRequests(actorToken, scopeId));
      if (generation === chatLoadGeneration.current && eventScopeRef.current === scopeId) {
        aiWasAvailableRef.current = ai.capability.status === "available";
        const refreshedChat = { ...nextChat, revision: ai.resourceRevision };
        chatRef.current = refreshedChat;
        dispatch({ type: "patch", patch: {
          aiAvailability: sharedAiAvailability(ai.capability.status),
          aiRequests: ai.requests, approvals: ai.approvals,
          aiError: "", chat: refreshedChat,
        } });
      }
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] shared AI refresh unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === chatLoadGeneration.current && eventScopeRef.current === scopeId) {
        dispatch({ type: "ai_refresh_failed", retainQueue: aiWasAvailableRef.current });
      }
    }
    const sequence = combined.at(-1)?.sequence;
    if (sequence) void updateSharedChatReadState(actorToken, scopeId, sequence).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] realtime read state failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  }, [token]);
  const activeScope = view.kind === "chat"
    ? { id: view.scopeId, kind: "chat" as const }
    : null;
  const activeScopeId = activeScope?.id ?? null;
  const activeScopeKind = activeScope?.kind ?? null;
  useEffect(() => {
    if (!activeScopeId || !activeScopeKind) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: RetryTimer | null = null;
    let attempt = 0;
    const retry = (connect: () => Promise<void>) => {
      const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
      attempt += 1;
      retryTimer?.cancel();
      retryTimer = createRetryTimer(() => { void connect(); }, delay);
    };
    const connect = async () => {
      try {
        const actorToken = await token();
        const ticket = await fetchCollaborationEventTicket(actorToken, activeScopeId, randomUuid());
        if (closed) return;
        const NativeWebSocket = WebSocket as unknown as new (
          target: string,
          protocols?: string | string[],
          options?: { headers: Record<string, string> },
        ) => WebSocket;
        const next = new NativeWebSocket(
          collaborationEventsUrl(activeScopeId, ticket.ticket, eventSequenceRef.current),
          undefined,
          { headers: { Authorization: `Bearer ${actorToken}` } },
        );
        socket = next;
        let usable = true;
        let refreshQueue = Promise.resolve();
        const enqueueAfterRecovery = (operation: () => void | Promise<void>) => {
          refreshQueue = refreshQueue.then(async () => {
            if (!usable || closed) return;
            await operation();
          }).catch((failure: unknown) => {
            if (failure instanceof CollaborationRecoverySupersededError) return;
            console.warn("[mobile-collaboration] realtime refresh failed", failure instanceof Error ? failure.name : "UnknownError");
            if (!closed && eventScopeRef.current === activeScopeId) {
              dispatch({ type: "patch", patch: { error: "This shared Chat could not be refreshed. Try again." } });
            }
            if (usable && !closed) {
              usable = false;
              next.close(1011, "Refresh failed");
            }
          });
        };
        next.onopen = () => { attempt = 0; };
        next.onmessage = (event) => {
          if (!usable) return;
          if (typeof event.data !== "string" || event.data.length > 64 * 1024) {
            next.close(1008, "Invalid frame");
            return;
          }
          try {
            const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
            if (frame.scopeId !== activeScopeId) throw new Error("ScopeMismatch");
            if (frame.type === "heartbeat") {
              if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "ready") {
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "unavailable") {
              closed = true;
              eventScopeRef.current = null;
              chatLoadGeneration.current += 1;
              chatRef.current = null;
              messagesRef.current = [];
              latestSequenceRef.current = "0";
              aiWasAvailableRef.current = false;
              dispatch({ type: "patch", patch: {
                scope: null,
                chat: null,
                messages: [],
                hasMoreMessages: false,
                loadingMoreMessages: false,
                aiDraft: "",
                aiRequests: [],
                approvals: [],
                aiAvailability: "unavailable",
                aiError: "",
                loading: false,
                error: "This shared Chat is unavailable. Your access may have changed.",
              } });
              next.close(1008, "Unavailable");
            } else if (frame.type === "changed" || frame.type === "capabilities_changed" || frame.type === "refresh_required") {
              enqueueAfterRecovery(async () => {
                await refreshLiveChat(activeScopeId);
                if (usable && !closed) eventSequenceRef.current = frame.sequence;
              });
            }
          } catch (failure: unknown) {
            console.warn("[mobile-collaboration] event frame rejected", failure instanceof Error ? failure.name : "UnknownError");
            next.close(1008, "Invalid frame");
          }
        };
        next.onerror = () => next.close();
        next.onclose = () => {
          usable = false;
          if (socket === next) socket = null;
          if (closed) return;
          retry(connect);
        };
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] event connection failed", failure instanceof Error ? failure.name : "UnknownError");
        if (closed) return;
        retry(connect);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (eventScopeRef.current === activeScopeId) eventScopeRef.current = null;
      retryTimer?.cancel();
      socket?.close(1000, "Closed");
    };
  }, [activeScopeId, activeScopeKind, refreshLiveChat, token]);
  const review = async (invitationId: string) => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try { dispatch({ type: "patch", patch: { view: { kind: "invitation", invitation: await fetchCollaborationInvitation(await token(), invitationId) } } }); }
    catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation load failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "This invitation is unavailable." } });
    } finally { dispatch({ type: "patch", patch: { loading: false } }); }
  };
  const accept = async (invitation: Invitation) => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try {
      const result = await acceptCollaborationInvitation(await token(), invitation.id, invitation.revision, randomUuid());
      notifyCollaborationDiscoveryChanged();
      if (invitation.scopeKind === "chat") await loadChat(result.scopeId);
      else if (invitation.scopeKind === "terminal") {
        dispatch({ type: "patch", patch: { view: { kind: "terminal", scopeId: result.scopeId }, loading: false } });
      } else dispatch({ type: "patch", patch: { view: { kind: "project", scopeId: result.scopeId }, loading: false } });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation acceptance failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Invitation could not be accepted. Try again.", loading: false } });
    }
  };
  const decline = async (invitation: Invitation) => {
    dispatch({ type: "patch", patch: { loading: true, error: "" } });
    try {
      await declineCollaborationInvitation(await token(), invitation.id, invitation.revision, randomUuid());
      notifyCollaborationDiscoveryChanged();
      dispatch({ type: "patch", patch: { view: { kind: "home" }, loading: false } });
      await loadHome();
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] invitation decline failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { error: "Invitation could not be declined. Try again.", loading: false } });
    }
  };
  const updateDraft = (text: string) => {
    dispatch({ type: "patch", patch: { aiDraft: text } });
    if (!chat || view.kind !== "chat") return;
    void saveCollaborationDraft(AsyncStorage, {
      actorId: userId, scopeId: view.scopeId, chatId: chat.id, mode: "ai", text,
    }).catch((failure: unknown) => {
      console.warn("[mobile-collaboration] draft save failed", failure instanceof Error ? failure.name : "UnknownError");
    });
  };
  const requestAi = async () => {
    if (!scope || !chat || view.kind !== "chat" || !state.aiDraft.trim()
      || state.aiAvailability !== "available" || scope.role === "viewer" || !scope.capabilities.requestAi) return;
    const generation = chatLoadGeneration.current;
    const requestScopeId = view.scopeId;
    const requestChatId = chat.id;
    const isCurrentChat = () => generation === chatLoadGeneration.current
      && eventScopeRef.current === requestScopeId && chatRef.current?.id === requestChatId;
    dispatch({ type: "patch", patch: { sending: true, aiError: "" } });
    try {
      const accepted = await postSharedAiRequest(
        await token(), requestScopeId, chat.revision, state.aiDraft.trim(), randomUuid(),
      );
      await saveCollaborationDraft(AsyncStorage, {
        actorId: userId, scopeId: requestScopeId, chatId: requestChatId, mode: "ai", text: "",
      });
      if (!isCurrentChat()) return;
      chatRef.current = { ...chatRef.current!, revision: accepted.resourceRevision };
      dispatch({
        type: "ai_request_accepted",
        scopeId: requestScopeId,
        chatId: requestChatId,
        request: accepted.request,
        resourceRevision: accepted.resourceRevision,
      });
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] shared AI request failed", failure instanceof Error ? failure.name : "UnknownError");
      if (isCurrentChat()) {
        dispatch({ type: "patch", patch: { aiError: "AI request was not accepted. Your draft is still here—try again." } });
      }
    } finally {
      if (isCurrentChat()) dispatch({ type: "patch", patch: { sending: false } });
    }
  };
  const refreshAiRequests = async (scopeId: string) => {
    const ai = CollaborationAiRequestsResponseSchema.parse(await fetchSharedAiRequests(await token(), scopeId));
    if (eventScopeRef.current !== scopeId) return;
    aiWasAvailableRef.current = ai.capability.status === "available";
    const currentChat = chatRef.current;
    const refreshedChat = currentChat ? { ...currentChat, revision: ai.resourceRevision } : null;
    if (refreshedChat) chatRef.current = refreshedChat;
    dispatch({ type: "patch", patch: {
      aiAvailability: sharedAiAvailability(ai.capability.status),
      aiRequests: ai.requests, approvals: ai.approvals,
      aiError: "", ...(refreshedChat ? { chat: refreshedChat } : {}),
    } });
  };
  const controlAi = async (request: CollaborationAiRequest, action: "cancel" | "retry") => {
    if (!scope || !chat || view.kind !== "chat" || state.sending || !canControlSharedAiRequest(scope.role, userId ?? "", request)) return;
    dispatch({ type: "patch", patch: { sending: true, aiError: "" } });
    try {
      await controlSharedAiRequest(await token(), view.scopeId, request.id, action, chat.revision, randomUuid());
      await refreshAiRequests(view.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] shared AI control failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { aiError: "The request changed or the control could not be applied. Refresh and try again." } });
    } finally { dispatch({ type: "patch", patch: { sending: false } }); }
  };
  const decideApproval = async (
    approval: CollaborationApproval,
    decision: "approve" | "approve_for_session" | "decline" | "cancel",
  ) => {
    if (!scope || !chat || view.kind !== "chat" || scope.role !== "owner" || state.sending) return;
    dispatch({ type: "patch", patch: { sending: true, aiError: "" } });
    try {
      await decideSharedAiApproval(
        await token(), view.scopeId, approval.approvalId, approval.runId, decision, chat.revision, randomUuid(),
      );
      await refreshAiRequests(view.scopeId);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] shared AI approval failed", failure instanceof Error ? failure.name : "UnknownError");
      dispatch({ type: "patch", patch: { aiError: "The approval changed or the decision could not be applied. Refresh and try again." } });
    } finally { dispatch({ type: "patch", patch: { sending: false } }); }
  };
  const markdownTheme = useMemo(() => ({
    textStyle: { color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body, fontSize: 15, lineHeight: 22 },
    mutedColor: theme.v2.appColors.muted, linkColor: theme.v2.colors.action,
    codeBackground: theme.v2.appColors.soft, codeBorderColor: theme.v2.colors.borderSubtle,
    monoFontFamily: theme.v2.fonts.mono, boldFontFamily: theme.v2.fonts.semibold, headingFontFamily: theme.v2.fonts.display,
  }), [theme]);

  if (view.kind === "invitation") return <InvitationScreen invitation={view.invitation} state={state}
    onBack={() => dispatch({ type: "patch", patch: { view: { kind: "home" } } })}
    onAccept={accept} onDecline={decline} />;

  if (view.kind === "chat") {
    return <SharedChatScreen state={state} actorId={userId ?? ""} markdownTheme={markdownTheme}
      onBack={() => {
        chatLoadGeneration.current += 1;
        eventScopeRef.current = null;
        chatRef.current = null;
        messagesRef.current = [];
        aiWasAvailableRef.current = false;
        dispatch({ type: "patch", patch: { view: { kind: "home" }, loadingMoreMessages: false } });
        void loadHome();
      }}
      getToken={token} onLoadMore={loadMoreMessages} onDraftChange={updateDraft}
      onRequestAi={requestAi} onControlAi={controlAi} onDecideApproval={decideApproval} />;
  }

  if (view.kind === "terminal") {
    return <SharedTerminalScreen scopeId={view.scopeId} actorId={userId ?? ""} getToken={token}
      onBack={() => {
        dispatch({ type: "patch", patch: { view: { kind: "home" }, error: "" } });
        void loadHome();
      }} />;
  }

  if (view.kind === "project") {
    return <SharedProjectScreen scopeId={view.scopeId} getToken={token} onBack={() => {
      dispatch({ type: "patch", patch: { view: { kind: "home" }, error: "" } });
      void loadHome();
    }} />;
  }

  return <CollaborationHomeScreen state={state} onReview={review} onAccept={accept} onDecline={decline}
    onOpen={(item) => item.kind === "terminal"
      ? Promise.resolve(dispatch({ type: "patch", patch: { view: { kind: "terminal", scopeId: item.scopeId } } }))
      : item.kind === "project"
        ? Promise.resolve(dispatch({ type: "patch", patch: { view: { kind: "project", scopeId: item.scopeId } } }))
        : loadChat(item.scopeId)} onLoadMore={loadMoreItems} />;
}

function InvitationScreen({ invitation, state, onBack, onAccept, onDecline }: {
  invitation: Invitation;
  state: ScreenState;
  onBack: () => void;
  onAccept: (invitation: Invitation) => Promise<void>;
  onDecline: (invitation: Invitation) => Promise<void>;
}) {
  return <ScrollView contentContainerStyle={styles.page}>
    <Back onPress={onBack} />
    <Text style={styles.title}>Join this shared {invitation.scopeKind === "terminal" ? "terminal" : invitation.scopeKind === "project" ? "project" : "Chat"}?</Text>
    <Text style={styles.body}>{invitation.owner.displayName} invited you as an {invitation.role}.</Text>
    <View style={styles.card}><Text style={styles.cardTitle}>This share includes</Text>
      <Text style={styles.body}>{invitation.scopeKind === "terminal"
        ? "This terminal session, its retained output, and attributed control while the session remains active."
        : invitation.scopeKind === "project" ? "The complete project inventory and future project-owned contents."
          : "The ongoing Chat history, human discussion, and shared AI queue."}</Text>
      <Text style={styles.cardTitle}>This stays private</Text><Text style={styles.body}>{invitation.scopeKind === "terminal"
        ? "Its project, sibling terminals, files, apps, Chats, credentials, and unrelated runtime access."
        : invitation.scopeKind === "project" ? "External references, credentials, unrelated resources, and personal view state."
          : "Its project, sibling Chats, files, apps, terminals, and private drafts."}</Text></View>
    <Text style={styles.muted}>{invitation.scopeKind === "terminal"
      ? "Editors can request control. Viewers can only watch. Owners may take over control."
      : "Editors can discuss and request AI. Viewers have read-only access."}</Text>
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    <Action label={state.loading ? "Accepting…" : "Accept invitation"} disabled={state.loading} onPress={() => void onAccept(invitation)} />
    <SecondaryAction label="Decline invitation" disabled={state.loading} onPress={() => void onDecline(invitation)} />
  </ScrollView>;
}

function SharedChatScreen({ state, actorId, markdownTheme, getToken, onBack, onLoadMore, onDraftChange,
  onRequestAi, onControlAi, onDecideApproval }: {
  state: ScreenState;
  actorId: string;
  markdownTheme: ChatMarkdownTheme;
  getToken: () => Promise<string>;
  onBack: () => void;
  onLoadMore: () => Promise<void>;
  onDraftChange: (text: string) => void;
  onRequestAi: () => Promise<void>;
  onControlAi: (request: CollaborationAiRequest, action: "cancel" | "retry") => Promise<void>;
  onDecideApproval: (approval: CollaborationApproval, decision: "approve" | "approve_for_session" | "decline" | "cancel") => Promise<void>;
}) {
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const visibleMessages = useMemo(
    () => state.messages.filter((message) => message.purpose !== "discussion"),
    [state.messages],
  );
  const renderMessage = useCallback(({ item }: ListRenderItemInfo<Message>) => (
    <ChatMessageCard message={item} markdownTheme={markdownTheme} />
  ), [markdownTheme]);
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <SharedChatHeader state={state} getToken={getToken} onBack={onBack} onOpenDiscussion={() => setDiscussionOpen(true)} />
    {state.loading ? <ActivityIndicator accessibilityLabel="Loading shared Chat" /> : null}
    <FlatList data={visibleMessages} keyExtractor={(message) => message.id} contentContainerStyle={styles.history}
      renderItem={renderMessage}
      ListEmptyComponent={!state.loading ? <Text style={styles.emptyHistory}>Message Matrix to start this Chat.</Text> : null}
      ListFooterComponent={state.hasMoreMessages ? <Action label={state.loadingMoreMessages ? "Loading…" : "Load more messages"}
        disabled={state.loadingMoreMessages} onPress={() => void onLoadMore()} /> : null} />
    <SharedChatComposer state={state} actorId={actorId} onDraftChange={onDraftChange}
      onRequestAi={onRequestAi} onControlAi={onControlAi} onDecideApproval={onDecideApproval} />
    {state.scope ? <SessionDiscussionSheet open={discussionOpen} scope={state.scope} actorId={actorId}
      getToken={getToken} onClose={() => setDiscussionOpen(false)} /> : null}
  </KeyboardAvoidingView>;
}

function SharedChatHeader({ state, getToken, onBack, onOpenDiscussion }: {
  state: ScreenState;
  getToken: () => Promise<string>;
  onBack: () => void;
  onOpenDiscussion: () => void;
}) {
  return <View style={styles.header}>
    <View style={styles.headerTop}><Back onPress={onBack} />
      <View style={styles.headerActions}>
        <SecondaryAction label="Open discussion" onPress={onOpenDiscussion} compact />
        {state.scope ? <SessionAccessControl key={state.scope.id} scope={state.scope} getToken={getToken} /> : null}
      </View>
    </View>
    <Text style={styles.title}>{state.chat?.title ?? "Chat"}</Text>
  </View>;
}

function ChatMessageCard({ message, markdownTheme }: { message: Message; markdownTheme: ChatMarkdownTheme }) {
  const human = message.role === "user";
  return <View style={[styles.message, human ? styles.humanMessage : styles.aiMessage]}>
    <Text style={styles.messageAuthor}>{human ? message.actor.displayName : "Matrix"}</Text>
    {keyedMessageParts(message).map(({ key, part }) => <View key={key}>
      {part.type === "text" || part.type === "summary" ? renderChatMarkdown(part.text, markdownTheme) : null}
      {part.type === "attachment_reference" ? <Text style={styles.muted}>Attachment: {part.label}</Text> : null}
    </View>)}
  </View>;
}

function CollaborationHomeScreen({ state, onReview, onAccept, onDecline, onOpen, onLoadMore }: {
  state: ScreenState;
  onReview: (invitationId: string) => Promise<void>;
  onAccept: (invitation: Invitation) => Promise<void>;
  onDecline: (invitation: Invitation) => Promise<void>;
  onOpen: (item: Extract<DiscoveryItem, { status: "accepted" }>) => Promise<void>;
  onLoadMore: () => Promise<void>;
}) {
  const renderDiscovery = useCallback(({ item }: ListRenderItemInfo<DiscoveryItem>) => (
    <DiscoveryCard item={item} onReview={onReview} onAccept={onAccept} onDecline={onDecline} onOpen={onOpen} />
  ), [onAccept, onDecline, onOpen, onReview]);
  return <FlatList data={state.items} keyExtractor={discoveryKey} contentContainerStyle={styles.page}
    ListHeaderComponent={<>
      <Text style={styles.title}>Shared with me</Text>
      <Text style={styles.muted}>Invitations, Chats, terminals, and projects shared with your Matrix account.</Text>
      {state.loading ? <ActivityIndicator accessibilityLabel="Loading shared items" /> : null}
      {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
      {!state.loading && !state.error && state.items.length === 0 ? <View style={styles.empty}>
        <Text style={styles.cardTitle}>Nothing shared yet</Text><Text style={styles.muted}>Invitations and accepted shared items will appear here.</Text>
      </View> : null}
    </>}
    renderItem={renderDiscovery}
    ListFooterComponent={<>
      {state.paginationError ? <Text accessibilityRole="alert" style={styles.error}>{state.paginationError}</Text> : null}
      {state.inboxCursor || state.sharedCursor ? <Action label={state.loadingMoreItems ? "Loading…" : "Load more shared items"}
        disabled={state.loadingMoreItems} onPress={() => void onLoadMore()} /> : null}
    </>} />;
}

function DiscoveryCard({ item, onReview, onAccept, onDecline, onOpen }: {
  item: DiscoveryItem;
  onReview: (invitationId: string) => Promise<void>;
  onAccept: (invitation: Invitation) => Promise<void>;
  onDecline: (invitation: Invitation) => Promise<void>;
  onOpen: (item: Extract<DiscoveryItem, { status: "accepted" }>) => Promise<void>;
}) {
  if (item.status === "invited") return <View style={styles.card}>
    <Text style={styles.cardTitle}>{item.resource.owner.displayName} invited you</Text>
    <Text style={styles.muted}>Shared {item.kind === "terminal" ? "terminal" : item.kind === "project" ? "project" : "Chat"} · {roleLabel(item.resource.role)}</Text>
    <View style={styles.invitationActions}>
      <Action label={`Accept invitation from ${item.resource.owner.displayName}`} onPress={() => void onAccept(item.resource)} />
      <SecondaryAction label={`Decline invitation from ${item.resource.owner.displayName}`} onPress={() => void onDecline(item.resource)} />
    </View>
    <SecondaryAction label={`View invitation details from ${item.resource.owner.displayName}`} onPress={() => void onReview(item.invitationId)} />
  </View>;
  if ("terminal" in item.resource) return <View style={styles.card}>
    <Text style={styles.cardTitle}>Shared terminal</Text>
    <Text style={styles.muted}>{item.resource.terminal.id} · {roleLabel(item.resource.scope.role)}</Text>
    <Action label={`Open shared terminal ${item.resource.terminal.id}`} onPress={() => void onOpen(item)} />
  </View>;
  if ("project" in item.resource) return <View style={styles.card}>
    <Text style={styles.cardTitle}>{item.resource.project.id}</Text>
    <Text style={styles.muted}>Shared project · {roleLabel(item.resource.scope.role)}</Text>
    <Action label={`Open shared project ${item.resource.project.id}`} onPress={() => void onOpen(item)} />
  </View>;
  return <View style={styles.card}>
    <Text style={styles.cardTitle}>{item.resource.chat.title}</Text>
    <Text style={styles.muted}>Shared Chat · {roleLabel(item.resource.scope.role)}</Text>
    <Action label={`Open ${item.resource.chat.title}`} onPress={() => void onOpen(item)} />
  </View>;
}

function keyedMessageParts(message: Message) {
  const occurrences: Record<string, number> = {};
  return message.parts.map((part) => {
    const valueKey = JSON.stringify(part);
    const occurrence = occurrences[valueKey] ?? 0;
    occurrences[valueKey] = occurrence + 1;
    return { key: `${message.id}:${valueKey}:${occurrence}`, part };
  });
}

type RetryTimer = { cancel: () => void };

function createRetryTimer(callback: () => void, delay: number): RetryTimer {
  const timer = setTimeout(callback, delay);
  return { cancel: () => clearTimeout(timer) };
}

function discoveryKey(item: DiscoveryItem): string {
  return item.status === "invited" ? `invite:${item.invitationId}` : `scope:${item.scopeId}`;
}

function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, (pressed || disabled) && styles.faded]}><Text style={styles.actionText}>{label}</Text></Pressable>;
}

function SecondaryAction({ label, onPress, disabled = false, compact = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.secondaryAction, compact && styles.compactAction, (pressed || disabled) && styles.faded]}>
    <Text style={styles.secondaryActionText}>{compact && label === "Open discussion" ? "Discussion" : label}</Text>
  </Pressable>;
}

function Back({ onPress }: { onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="Back to Shared with me" onPress={onPress}><Text style={styles.back}>‹ Shared with me</Text></Pressable>;
}

function roleLabel(role: "owner" | "editor" | "viewer"): string { return role[0]!.toUpperCase() + role.slice(1); }

function compareAcceptedSequence(left: CollaborationAiRequest, right: CollaborationAiRequest): number {
  const leftSequence = BigInt(left.acceptedSequence);
  const rightSequence = BigInt(right.acceptedSequence);
  return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
}

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.v2.appColors.canvas },
  page: { flexGrow: 1, gap: 16, padding: 20, backgroundColor: theme.v2.appColors.canvas },
  header: { gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.v2.colors.borderSubtle },
  headerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontFamily: theme.v2.fonts.display, fontSize: 26, color: theme.v2.appColors.ink },
  body: { fontFamily: theme.v2.fonts.body, fontSize: 15, lineHeight: 22, color: theme.v2.appColors.ink },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 13, lineHeight: 19, color: theme.v2.appColors.muted },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  card: { gap: 10, padding: 16, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16, backgroundColor: theme.v2.appColors.surface },
  cardTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.ink },
  empty: { alignItems: "center", gap: 6, padding: 32, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16 },
  history: { flexGrow: 1, gap: 12, padding: 16 },
  emptyHistory: { paddingVertical: 48, textAlign: "center", fontFamily: theme.v2.fonts.body, color: theme.v2.appColors.muted },
  message: { maxWidth: "88%", gap: 6, padding: 14, borderRadius: 16 },
  humanMessage: { alignSelf: "flex-end", backgroundColor: theme.v2.appColors.soft },
  aiMessage: { alignSelf: "flex-start", borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, backgroundColor: theme.v2.appColors.surface },
  messageAuthor: { fontFamily: theme.v2.fonts.semibold, fontSize: 12, color: theme.v2.appColors.muted },
  invitationActions: { flexDirection: "row", gap: 8 },
  action: { alignItems: "center", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: theme.v2.palette.green[800] },
  actionText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  secondaryAction: { alignItems: "center", borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  compactAction: { paddingHorizontal: 9, paddingVertical: 7, borderRadius: 10 },
  secondaryActionText: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.appColors.ink },
  faded: { opacity: 0.55 },
  back: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.action },
}));
