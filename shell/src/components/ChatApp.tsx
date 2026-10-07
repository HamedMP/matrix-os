"use client";
import type { ChatAgentDraftRequest, ChatCollaborationView, StartAgentChat } from "@matrix-os/ui";

import { ChatPresentation, ChatHistory, ChatStarterCards, MatrixChatAvatar, useChatReadState, CanonicalChatInputForm } from "@matrix-os/ui";
import type { CanonicalChatInputView, CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { ChatQueuedRequests } from "./chat/ChatQueuedRequests";
import { ChatContextReceipt } from "@matrix-os/ui";
import { ChatRunContextSchema, type CanonicalChatQueuedTurn } from "@matrix-os/contracts";
import { ChatInput } from "./chat/ChatInput";
import { useChatComposerDraft } from "./chat/useChatComposerDraft";
import { ChatAgentsRailSection, ChatAgentsWorkspace, ChatAgentsContent, useChatAgentsNavigation, type ChatAgentClient } from "@matrix-os/ui";
import type { ChatSubmitOptions } from "@/hooks/useChatState";
import { ChatSharing } from "./chat/ChatSharing";
import { SharedWithMeNav } from "./chat/SharedWithMeNav";
import { ShellChatCollaboration } from "./chat/ShellChatCollaboration";
import { ChatAttachments, ChatContextMenu } from "@matrix-os/ui";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { resolveChatMessageLink } from "@matrix-os/contracts";
import { ChatFilePanel, loadChatFile } from "./chat/ChatFilePanel";
import type {
  CanonicalChatApprovalDecision,
  CanonicalChatModelSelection,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { type ChatMessage, groupMessages } from "@/lib/chat";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { extractThinking } from "@/components/ai-elements/reasoning-utils";
import { SuggestionChips } from "@/components/ai-elements/suggestions";
import { getMessageSuggestions } from "@/components/ai-elements/suggestions-utils";
import { Plan } from "@/components/ai-elements/plan";
import { parsePlan } from "@/components/ai-elements/plan-utils";
import { Task } from "@/components/ai-elements/task";
import { parseTask } from "@/components/ai-elements/task-utils";
import { RichContent } from "@/components/ui-blocks";
import { ToolCallGroup } from "@/components/ToolCallGroup";
import { Button } from "@/components/ui/button";
import { ShellNotificationCard } from "@/components/ShellNotificationCard";
import { ShellNotificationPortal } from "@/components/ShellNotificationPortal";
import {
  CANONICAL_PROVIDER_SETUP_ERROR,
  executeCanonicalProviderSetupAction,
  openProviderSettings,
} from "@/lib/canonical-provider-setup";
import {
  DEFAULT_HERMES_CHANNELS,
  createChannelConfiguredPrompt,
} from "./chat-app-hermes";
import {
  ChatProviderSetupPanel,
  useChatProviderState,
} from "./chat-app-provider-setup";
import {
  CanonicalApprovalMessage,
  canonicalApproval,
} from "./chat/CanonicalApprovalMessage";
import {
  ChatTitleEditor,
  type RenameableConversation,
} from "./chat/ChatTitleRename";
import {
  PlusIcon,
  PanelLeftIcon,
  SearchIcon,
  MessageSquareIcon,
  Settings2Icon,
  ChevronDownIcon,
} from "@/lib/hugeicons";

type ConversationMeta = RenameableConversation;

function loadShellChatImage(src: string) {
  const path = new URL(src, "https://matrix.invalid").searchParams.get("path");
  if (!path) return Promise.reject(new Error("InvalidChatImage"));
  return loadChatFile(path);
}

const HERMES_SETUP_STORAGE_KEY = "matrix:hermes-setup";

function readHermesSetup() {
  if (typeof window === "undefined") {
    return { channels: DEFAULT_HERMES_CHANNELS };
  }
  try {
    const raw = window.localStorage.getItem(HERMES_SETUP_STORAGE_KEY);
    if (!raw) return { channels: DEFAULT_HERMES_CHANNELS };
    const parsed = JSON.parse(raw) as { channels?: unknown };
    return {
      channels: Array.isArray(parsed.channels)
        ? parsed.channels.filter((channel): channel is string => typeof channel === "string").slice(0, 8)
        : DEFAULT_HERMES_CHANNELS,
    };
  } catch (err: unknown) {
    console.warn("[chat] Failed to load Hermes setup:", err instanceof Error ? err.message : String(err));
    return { channels: DEFAULT_HERMES_CHANNELS };
  }
}

function writeHermesSetup(channels: string[]) {
  try {
    window.localStorage.setItem(HERMES_SETUP_STORAGE_KEY, JSON.stringify({ channels }));
  } catch (err: unknown) {
    console.warn("[chat] Failed to save Hermes setup:", err instanceof Error ? err.message : String(err));
  }
}

interface ChatAppProps {
  collaborationView?: ChatCollaborationView;
  onOpenSharedChat?: (scopeId: string) => void;
  onOpenSharedHome?: () => void;
  filterUnreadOnly?: boolean;
  onUnreadFilterChange?: (value: boolean) => void;
  active?: boolean;
  readState?: import("@matrix-os/contracts").CanonicalChatReadState;
  displayedThroughSeq?: number;
  onUpdateReadState?: (chatId: string, input: import("@matrix-os/contracts").CanonicalUpdateChatReadStateRequest) => Promise<boolean>;
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  conversations: ConversationMeta[];
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  activeConversationTitle?: string;
  onRenameConversation?: (id: string, title: string) => Promise<boolean>;
  onSubmit: (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: ChatSubmitOptions,
  ) => void | Promise<boolean>;
  agentClient?: ChatAgentClient;
  queuedTurns?: CanonicalChatQueuedTurn[];
  onCancelQueuedTurn?: (id: string) => Promise<boolean>;
  providerSelection?: CanonicalChatModelSelection;
  boundProviderInstanceId?: string;
  onSubmitInput?: (runId: string, requestId: string, input: Omit<CanonicalSubmitChatInputRequest, "clientRequestId">) => Promise<boolean>;
  onSubmitApproval?: (
    runId: string,
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
  ) => Promise<boolean>;
  composerDraftRequest?: ChatAgentDraftRequest | null;
  onComposerDraftConsumed?: (id: number) => void;
  onProviderSetupAction?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  mobile?: boolean;
}

export function ChatApp(props: ChatAppProps) {
  return <ChatAgentsWorkspace><ChatAppContent {...props} /></ChatAgentsWorkspace>;
}

function ChatAppContent({
  collaborationView, onOpenSharedChat, onOpenSharedHome,
  filterUnreadOnly, onUnreadFilterChange,
  active = true, readState, displayedThroughSeq = 0, onUpdateReadState,
  messages,
  sessionId,
  busy,
  connected,
  conversations,
  onNewChat: createChat,
  onSwitchConversation: switchConversation,
  activeConversationTitle,
  onRenameConversation,
  onSubmit,
  providerSelection,
  boundProviderInstanceId,
  agentClient, queuedTurns = [], onCancelQueuedTurn,
  onSubmitApproval,
  onSubmitInput,
  composerDraftRequest,
  onComposerDraftConsumed,
  onProviderSetupAction,
  mobile = false,
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- these useState fields are independent UI concerns with separate update sites and lifecycles, not one related state machine.
}: ChatAppProps) {
  const agentsNavigation = useChatAgentsNavigation();
  const [localUnreadOnly, setUnreadOnly] = useState(false);
  const unreadOnly = filterUnreadOnly ?? localUnreadOnly;
  useChatReadState({ chatId: sessionId, state: readState, throughSeq: displayedThroughSeq,
    active: active && !agentsNavigation?.opened, onRead: onUpdateReadState });
  const [newChatSequence, setNewChatSequence] = useState(0);
  const [agentDraftRequest, setAgentDraftRequest] = useState<ChatAgentDraftRequest | null>(null);
  const composerScope = sessionId ?? `new:${newChatSequence}`;
  const onNewChat = () => {
    agentsNavigation?.close();
    setNewChatSequence((sequence) => sequence + 1);
    setAgentDraftRequest(null);
    createChat();
  };
  const onSwitchConversation = (id: string) => { agentsNavigation?.close(); switchConversation(id); };
  const composer = useChatComposerDraft(composerScope, agentClient);
  const [sidebarOpen, setSidebarOpen] = useState(!mobile);
  const agentDraftSequence = useRef(0);
  const startAgentChat: StartAgentChat = (text, resources) => {
    agentDraftSequence.current += 1;
    setNewChatSequence((sequence) => sequence + 1);
    createChat();
    setAgentDraftRequest({ id: agentDraftSequence.current, text, resources });
    if (mobile) setSidebarOpen(false);
  };
  const activeDraftRequest = !sessionId && agentDraftRequest ? agentDraftRequest : composerDraftRequest;
  const consumeDraftRequest = (id: number) => {
    if (agentDraftRequest?.id === id) setAgentDraftRequest(null);
    else onComposerDraftConsumed?.(id);
  };
  const [previewFile, setPreviewFile] = useState<{ chatId: string; path: string } | null>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const openMessageFile = (path: string) => {
    const target = resolveChatMessageLink(path);
    if (!sessionId || target?.kind !== "file") return false;
    previewTrigger.current = document.activeElement as HTMLElement | null;
    setPreviewFile({ chatId: sessionId, path: target.path });
    return true;
  };
  const [setupOpen, setSetupOpen] = useState(false);
  const [submittingApprovalId, setSubmittingApprovalId] = useState<string | null>(null);
  const [providerSetupError, setProviderSetupError] = useState<string | null>(null);
  const collaborationViewKey = collaborationView ? JSON.stringify(collaborationView) : null;
  const [sharedMetadata, setSharedMetadata] = useState<{
    viewKey: string;
    title: string;
    role: "owner" | "editor" | "viewer";
  } | null>(null);
  const [collaborationHeaderContainer, setCollaborationHeaderContainer] = useState<HTMLDivElement | null>(null);
  const activeSharedMetadata = sharedMetadata?.viewKey === collaborationViewKey ? sharedMetadata : null;
  const handleSharedMetadata = useCallback((metadata: {
    title: string;
    role: "owner" | "editor" | "viewer";
  }) => {
    if (!collaborationViewKey) return;
    setSharedMetadata({ ...metadata, viewKey: collaborationViewKey });
  }, [collaborationViewKey]);
  const [editingChat, setEditingChat] = useState<{ id: string; source: "header" | "rail" } | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const initialHermesSetupRef = useRef<ReturnType<typeof readHermesSetup> | null>(null);
  const getInitialHermesSetup = () => {
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot yet lower the `??=` logical-assignment operator (BuildHIR Todo); this lazy one-time ref cache is a deliberate first-render localStorage read and rewriting it would not change behavior.
    initialHermesSetupRef.current ??= readHermesSetup();
    return initialHermesSetupRef.current;
  };
  // react-doctor-disable-next-line react-hooks-js/refs -- lazy initializer performs one bounded localStorage read.
  const [channels, setChannels] = useState(() => new Set(getInitialHermesSetup().channels));
  const providerState = useChatProviderState(providerSelection, boundProviderInstanceId);
  // Comfortable ≥44px touch targets on mobile; unchanged on desktop.
  const touchIcon = mobile ? "size-9" : "size-8";
  const grouped = groupMessages(messages);
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is consumed by the writeHermesSetup useEffect dependency array below; keep an explicit useMemo so the persisted-setup effect only re-runs when the channel set actually changes, not on every render.
  const selectedChannels = useMemo(() => Array.from(channels).sort(), [channels]);
  useEffect(() => {
    writeHermesSetup(selectedChannels);
  }, [selectedChannels]);
  const submitWithHermesSetup = (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    mentionOptions?: ChatSubmitOptions,
  ) => {
    if (!providerState.selected) return Promise.resolve(false);
    const usesChannels = providerState.selected.driverKind === "hermes";
    const promptText = usesChannels ? createChannelConfiguredPrompt(text, selectedChannels) : text;
    return onSubmit(text, files, {
      displayText: text,
      ...(promptText === text ? {} : { promptText }),
      instanceId: providerState.selected.instanceId,
      model: providerState.selected.modelId,
      interactionMode: providerState.selected.interactionMode,
      permissionMode: mentionOptions?.permissionMode ?? providerState.selected.permissionMode,
      ...(mentionOptions?.resources?.length ? { resources: mentionOptions.resources, clientRequestId: mentionOptions.clientRequestId } : {}),
      modelOptions: providerState.selected.selectedOptions,
    });
  };

  const suggestions = getMessageSuggestions(messages);

  const isEmpty = messages.length === 0 && !busy;

  const runProviderSetupAction = async (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => {
    setProviderSetupError(null);
    if (onProviderSetupAction) {
      onProviderSetupAction(instance, action);
      return;
    }
    try {
      const completed = await executeCanonicalProviderSetupAction({ instance, action });
      if (!completed) setProviderSetupError(CANONICAL_PROVIDER_SETUP_ERROR);
    } catch (error: unknown) {
      console.warn("[chat] Provider setup dispatch failed:", error instanceof Error ? error.name : typeof error);
      setProviderSetupError(CANONICAL_PROVIDER_SETUP_ERROR);
    }
  };

  return (
    <ChatPresentation className="relative flex h-full" onClickCapture={(event) => {
      const element = event.target instanceof Element ? event.target : null;
      const anchor = element?.closest("a");
      const code = element?.closest("code");
      const raw = anchor?.getAttribute("href") ?? (code && !code.closest("pre") ? code.textContent : null);
      if (!raw) return;
      const target = resolveChatMessageLink(raw);
      if (target?.kind === "file" && (anchor || /[/.]/.test(raw))) {
        event.preventDefault();
        openMessageFile(target.path);
      }
    }}>
      {providerSetupError && (
        <ShellNotificationPortal>
          <ShellNotificationCard
            className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-[0_18px_60px_-24px_rgba(239,68,68,0.58),0_24px_60px_-30px_rgba(0,0,0,0.38)] backdrop-blur-md"
            role="alert"
          >
            {providerSetupError}
          </ShellNotificationCard>
        </ShellNotificationPortal>
      )}
      <aside className={`z-20 flex min-h-0 flex-col border-r ${sidebarOpen
        ? mobile ? "absolute inset-y-0 left-0 w-[min(86vw,320px)] shadow-2xl" : "w-[240px] shrink-0"
        : "w-0 overflow-hidden"}`} style={{ borderColor: "var(--chat-border)", background: "var(--chat-surface)" }}>
        <ChatHistory
          items={conversations.map(conversation => ({ id: conversation.id, title: conversation.title || conversation.preview || "New chat",
            preview: conversation.preview, updatedAt: conversation.updatedAt, unread: conversation.readState?.unread,
            conversationKind: conversation.conversationKind }))}
          activeChatId={sessionId} onSelect={onSwitchConversation} onNewChat={onNewChat}
          unreadOnly={unreadOnly} onUnreadOnlyChange={value => { setUnreadOnly(value); onUnreadFilterChange?.(value); }}
          onRename={onRenameConversation} renameDisabled={renamePending}
          onToggleRead={onUpdateReadState ? id => {
            const conversation = conversations.find(item => item.id === id);
            if (!conversation) return;
            void onUpdateReadState(id, conversation.readState?.unread
              ? { type: "mark_read", throughSeq: conversation.readState.latestIncomingSeq, baseVersion: conversation.readState.version }
              : { type: "mark_unread" });
          } : undefined}
          searchIcon={<SearchIcon className="size-4" />} newChatIcon={<PlusIcon className="size-4" />}
        >
          <div className="px-2 pb-2"><ChatAgentsRailSection client={agentClient} onStartChat={startAgentChat} onOpen={() => { if (mobile) setSidebarOpen(false); }} onSetup={() => setSetupOpen(true)} /></div>
          {onOpenSharedHome ? <SharedWithMeNav active={collaborationView?.kind === "home"} onOpen={() => { onOpenSharedHome(); if (mobile) setSidebarOpen(false); }} /> : null}
          {mobile ? <Button variant="ghost" size="sm" onClick={() => setSidebarOpen(false)}>Close sidebar</Button> : null}
        </ChatHistory>
      </aside>

      {/* Main content */}
      <ChatAgentsContent client={agentClient} scopeKey={sessionId ?? "draft"}>
      <main className="relative flex flex-1 flex-col min-w-0">
        {/* Top bar */}
        <header data-slot="chat-session-header" className={`flex items-center gap-2 border-b px-3 ${mobile ? "surface-glass min-h-14" : "min-h-12 border-border/30"}`}>
          {!sidebarOpen && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open Chat sidebar"
                className={`${touchIcon} text-muted-foreground hover:text-foreground`}
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`${touchIcon} text-muted-foreground hover:text-foreground`}
                onClick={onNewChat}
                title="New chat"
              >
                <PlusIcon className="size-4" />
              </Button>
            </>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-center gap-2">
              <MatrixChatAvatar />
              <div className="min-w-0 flex-1 text-center">
                {collaborationView ? (
                  <span className="block truncate px-1 text-sm font-semibold leading-4 text-foreground">
                    {activeSharedMetadata?.title ?? "Chat"}
                  </span>
                ) : editingChat?.source === "header" && editingChat.id === sessionId && activeConversationTitle ? (
                  <ChatTitleEditor
                    title={activeConversationTitle}
                    pending={renamePending}
                    onCancel={() => setEditingChat(null)}
                    onCommit={(title) => {
                      if (!sessionId || !onRenameConversation || renamePending) return;
                      setRenamePending(true);
                      void onRenameConversation(sessionId, title).then((saved) => {
                        if (saved) setEditingChat(null);
                      }).catch((error: unknown) => {
                        console.warn("[chat] Rename failed:", error instanceof Error ? error.name : "UnknownError");
                      }).finally(() => setRenamePending(false));
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    aria-label={activeConversationTitle ? `Rename ${activeConversationTitle}` : undefined}
                    title={activeConversationTitle}
                    disabled={!sessionId || !activeConversationTitle || !onRenameConversation || renamePending}
                    className={`max-w-full truncate rounded px-1 text-sm font-semibold leading-4 text-foreground outline-none enabled:hover:bg-accent/40 enabled:focus-visible:ring-2 enabled:focus-visible:ring-primary/40 ${mobile ? "min-h-11 py-2" : ""}`}
                    onClick={() => sessionId && activeConversationTitle && setEditingChat({ id: sessionId, source: "header" })}
                  >
                    {activeConversationTitle ?? providerState.activeInstance?.displayName ?? "Built-in AI"}
                  </button>
                )}
                <p className="truncate text-[10px] leading-3 text-muted-foreground">
                  {collaborationView
                    ? activeSharedMetadata ? `Shared · ${activeSharedMetadata.role}` : "Shared session"
                    : providerState.selected?.modelLabel ?? (providerState.loading ? "Loading AI access" : "AI access unavailable")}
                </p>
              </div>
            </div>
          </div>
          {!collaborationView && sessionId ? <ChatSharing key={sessionId} chatId={sessionId} /> : null}
          {collaborationView ? <div ref={setCollaborationHeaderContainer} className="flex shrink-0 items-center" /> : null}
          {!collaborationView ? <Button
            data-chat-model-trigger
            aria-label="Choose model and connection"
            aria-haspopup="dialog"
            aria-expanded={setupOpen}
            variant={setupOpen ? "secondary" : "ghost"}
            size="sm"
            className="h-8 max-w-[12rem] gap-1.5 px-2.5 text-xs"
            onClick={() => setSetupOpen((value) => !value)}
          >
            <span className="truncate">{providerState.selected ? `${providerState.selected.harnessLabel}${providerState.selected.connectionLabel && providerState.selected.connectionLabel !== providerState.selected.harnessLabel ? ` · ${providerState.selected.connectionLabel}` : ""} · Model` : "Model"}</span>
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          </Button> : null}
          {!collaborationView ? <Button
            aria-label="Open Agents & providers settings"
            title="Agents & providers"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => {
              setSetupOpen(false);
              openProviderSettings();
            }}
          >
            <Settings2Icon className="size-3.5" aria-hidden="true" />
          </Button> : null}
          {!connected && (
            <span className="text-[10px] text-destructive font-medium">Offline</span>
          )}
        </header>
        {!collaborationView && setupOpen && (
          <ChatProviderSetupPanel
            onDismiss={() => {
              setSetupOpen(false);
            }}
            catalog={providerState.catalog}
            choices={providerState.choices}
            selected={providerState.selected}
            onSelect={providerState.select}
            onInteractionModeChange={providerState.selectInteractionMode}
            onPermissionModeChange={providerState.selectPermissionMode}
            onOptionChange={providerState.selectOption}
            onSetupAction={(instance, action) => {
              void runProviderSetupAction(instance, action);
            }}
            lockedInstanceId={boundProviderInstanceId}
            showChannels={providerState.selected?.driverKind === "hermes"}
            channels={channels}
            onToggleChannel={(channel) => {
              setChannels((prev) => {
                const next = new Set(prev);
                if (next.has(channel)) next.delete(channel);
                else next.add(channel);
                return next;
              });
            }}
          />
        )}

        {collaborationView ? (
          <ShellChatCollaboration view={collaborationView} onOpenChat={onOpenSharedChat}
            onSessionMetadata={handleSharedMetadata} headerContainer={collaborationHeaderContainer} />
        ) : <>
        <ChatQueuedRequests key={`queue:${sessionId ?? "new"}`} turns={queuedTurns} onCancel={onCancelQueuedTurn} />
        {/* Empty state or conversation */}
        {isEmpty ? (
          <EmptyState
            composerProps={{ composer, agentClient, scope: composerScope, permissionMode: providerState.selected?.permissionMode ?? "supervised" }}
            onSubmit={submitWithHermesSetup}
            connected={connected}
            mobile={mobile}
            composerDraftRequest={activeDraftRequest}
            onComposerDraftConsumed={consumeDraftRequest}
            providerReady={providerState.selected !== null}
            attachmentsEnabled={providerState.selected?.supportsFileAttachments ?? false}
          />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <ChatContextMenu chatId={sessionId} zIndex={SHELL_Z_INDEX.popover}>
            <div className="contents">
            <Conversation>
              <ConversationContent className="gap-5 px-4 py-5 md:px-0 mx-auto w-full max-w-[868px]">
                {grouped.map((group) => {
                  if (group.type === "tool_group") {
                    return <ToolCallGroup key={`tg-${group.messages[0].id}`} tools={group.messages} />;
                  }
                  const msg = group.message;
                  return (
                    <div key={msg.id}>
                      {msg.role === "user" ? (
                        <Message from="user">
                          {msg.attachments?.length ? <ChatAttachments attachments={msg.attachments} open={openMessageFile} loadImage={loadShellChatImage} /> : null}
                          {msg.content.trim() ? <MessageContent data-chat-message="user">
                            <span className="whitespace-pre-wrap">{msg.content}</span>
                          </MessageContent> : null}
                        </Message>
                      ) : msg.metadata?.canonicalInput ? (
                        <CanonicalChatInputForm
                          key={`${sessionId}:${msg.id}`}
                          request={msg.metadata.canonicalInput as CanonicalChatInputView}
                          onSubmit={async (input) => {
                            const request = msg.metadata!.canonicalInput as CanonicalChatInputView;
                            return onSubmitInput ? onSubmitInput(request.runId, request.requestId, input) : false;
                          }}
                        />
                      ) : msg.role === "system" ? (
                        <CanonicalApprovalMessage
                          message={msg}
                          submitting={(() => {
                            const approval = canonicalApproval(msg);
                            return approval !== null
                              && submittingApprovalId === `${approval.runId}\0${approval.approvalId}`;
                          })()}
                          onSubmit={onSubmitApproval ? async (runId, approvalId, decision) => {
                            const submissionId = `${runId}\0${approvalId}`;
                            setSubmittingApprovalId(submissionId);
                            try { await onSubmitApproval(runId, approvalId, decision); }
                            finally { setSubmittingApprovalId(null); }
                          } : undefined}
                        />
                      ) : (
                    <AssistantBubble
                      content={msg.content}
                      attachments={msg.attachments}
                      openAttachment={openMessageFile}
                      loadImage={loadShellChatImage}
                      onAction={submitWithHermesSetup}
                    />
                      )}
                    <ChatContextReceipt context={ChatRunContextSchema.safeParse(msg.metadata?.chatRunContext).data} />
                    </div>
                  );
                })}

                {busy && (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground py-1">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse" style={{ animationDelay: "0ms" }} />
                      <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse" style={{ animationDelay: "150ms" }} />
                      <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                )}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>
            </div>
            </ChatContextMenu>

            {/* Suggestions + Input */}
            <div className="mx-auto w-full max-w-[868px] px-3 md:px-0 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2">
              {!busy && suggestions.length > 0 && (
                <div className="pb-3">
                  <SuggestionChips
                    suggestions={suggestions}
                    onSelect={(text) => submitWithHermesSetup(text)}
                  />
                </div>
              )}
              <ChatInput
                key={`composer:${composerScope}`} composer={composer} agentClient={agentClient} scope={composerScope} permissionMode={providerState.selected?.permissionMode ?? "supervised"}
                connected={connected && providerState.selected !== null}
                busy={busy}
                onSubmit={submitWithHermesSetup}
                draftRequest={activeDraftRequest}
                onDraftConsumed={consumeDraftRequest}
                unavailablePlaceholder={!providerState.loading && providerState.selected === null
                  ? "Write or dictate a draft — connect a harness to send"
                  : undefined}
                attachmentsEnabled={providerState.selected?.supportsFileAttachments ?? false}
              />
            </div>
          </div>
        )}
        </>}
      </main>
      {previewFile && previewFile.chatId === sessionId ? <ChatFilePanel key={`${sessionId}:${previewFile.path}`} path={previewFile.path} onClose={() => {
        setPreviewFile(null);
        if (previewTrigger.current?.isConnected) previewTrigger.current.focus();
      }} /> : null}
      </ChatAgentsContent>
    </ChatPresentation>
  );
}

function EmptyState({
  composerProps,
  onSubmit,
  connected,
  mobile,
  composerDraftRequest,
  onComposerDraftConsumed,
  providerReady,
  attachmentsEnabled,
}: {
  composerProps: Pick<React.ComponentProps<typeof ChatInput>, "composer" | "agentClient" | "scope" | "permissionMode">;
  onSubmit: React.ComponentProps<typeof ChatInput>["onSubmit"];
  connected: boolean;
  mobile: boolean;
  composerDraftRequest?: ChatAgentDraftRequest | null;
  onComposerDraftConsumed?: (id: number) => void;
  providerReady: boolean;
  attachmentsEnabled: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-8">
        <div className="w-full max-w-[480px]">
          {!providerReady ? <p role="status" className="mb-3 text-sm text-muted-foreground">Connect a harness in Settings to start chatting.</p> : null}
          <ChatStarterCards layout="two-by-two" density={mobile ? "compact" : "regular"}
            onSelect={text => composerProps.composer.setDraft({ text, resources: [] })} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[868px] shrink-0 px-5 pb-5">
        <ChatInput key={`composer:${composerProps.scope}`} {...composerProps}
          connected={connected && providerReady} busy={false} onSubmit={onSubmit}
          autoFocus={!mobile} draftRequest={composerDraftRequest} onDraftConsumed={onComposerDraftConsumed}
          unavailablePlaceholder={!providerReady ? "Write or dictate a draft — connect a harness to send" : undefined}
          attachmentsEnabled={attachmentsEnabled} />
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  attachments,
  openAttachment,
  loadImage,
  onAction,
}: {
  content: string;
  attachments?: ChatMessage["attachments"];
  openAttachment?: (path: string) => boolean | void;
  loadImage?: (src: string) => Promise<Blob>;
  onAction?: (text: string) => void;
}) {
  const { thinking, rest } = extractThinking(content);
  const planSteps = parsePlan(rest);
  const taskData = parseTask(rest);
  const displayContent = planSteps
    ? rest.replace(/```plan\n[\s\S]*?```/, "").trim()
    : taskData
      ? rest.replace(/```task\n[\s\S]*?```/, "").trim()
      : rest;

  return (
    <Message from="assistant">
      <MessageContent data-chat-message="assistant">
        {attachments?.length ? <ChatAttachments align="start" attachments={attachments} open={openAttachment} loadImage={loadImage} /> : null}
        {thinking && <Reasoning content={thinking} />}
        {planSteps && <Plan steps={planSteps} />}
        {taskData && <Task task={taskData} />}
        {displayContent && (
          <RichContent onAction={onAction} openFile={openAttachment}>{displayContent}</RichContent>
        )}
      </MessageContent>
    </Message>
  );
}
