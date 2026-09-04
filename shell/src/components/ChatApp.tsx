"use client";

import { useState, useMemo, useRef, useEffect } from "react";
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
import { Attachments, AttachmentButton, useAttachments } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { ChatHistoryRail, type ChatConversationMeta } from "@/components/chat/ChatHistoryRail";
import { ShellNotificationCard } from "@/components/ShellNotificationCard";
import { ShellNotificationPortal } from "@/components/ShellNotificationPortal";
import { Textarea } from "@/components/ui/textarea";
import { useVoice } from "@/hooks/useVoice";
import {
  CANONICAL_PROVIDER_SETUP_ERROR,
  executeCanonicalProviderSetupAction,
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
  PlusIcon,
  SendIcon,
  MicIcon,
  MicOffIcon,
  Loader2Icon,
  PanelLeftIcon,
  SearchIcon,
  BotIcon,
  Settings2Icon,
  SquareIcon,
  Bug,
  Hammer,
  CircleCheck,
} from "@/lib/hugeicons";

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
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  canAbort?: boolean;
  connected: boolean;
  conversations: ChatConversationMeta[];
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation?: (id: string) => Promise<boolean>;
  onSubmit: (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: {
      displayText?: string;
      promptText?: string;
      instanceId?: string;
      model?: string;
      interactionMode?: string;
      permissionMode?: string;
      modelOptions?: Array<{ id: string; value: string | boolean }>;
    },
  ) => void;
  onAbort?: () => void;
  providerSelection?: CanonicalChatModelSelection;
  onSubmitApproval?: (
    runId: string,
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
  ) => Promise<boolean>;
  composerDraftRequest?: { id: number; text: string } | null;
  onComposerDraftConsumed?: (id: number) => void;
  onProviderSetupAction?: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  mobile?: boolean;
}

export function ChatApp({
  messages,
  sessionId,
  busy,
  canAbort = false,
  connected,
  conversations,
  onNewChat,
  onSwitchConversation,
  onDeleteConversation,
  onSubmit,
  onAbort,
  providerSelection,
  onSubmitApproval,
  composerDraftRequest,
  onComposerDraftConsumed,
  onProviderSetupAction,
  mobile = false,
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- these useState fields are independent UI concerns with separate update sites and lifecycles, not one related state machine.
}: ChatAppProps) {
  const [sidebarOpen, setSidebarOpen] = useState(!mobile);
  const [setupOpen, setSetupOpen] = useState(false);
  const [submittingApprovalId, setSubmittingApprovalId] = useState<string | null>(null);
  const [providerSetupError, setProviderSetupError] = useState<string | null>(null);
  const initialHermesSetupRef = useRef<ReturnType<typeof readHermesSetup> | null>(null);
  const getInitialHermesSetup = () => {
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot yet lower the `??=` logical-assignment operator (BuildHIR Todo); this lazy one-time ref cache is a deliberate first-render localStorage read and rewriting it would not change behavior.
    initialHermesSetupRef.current ??= readHermesSetup();
    return initialHermesSetupRef.current;
  };
  // react-doctor-disable-next-line react-hooks-js/refs -- lazy initializer performs one bounded localStorage read.
  const [channels, setChannels] = useState(() => new Set(getInitialHermesSetup().channels));
  const providerState = useChatProviderState(providerSelection);
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
  ) => {
    if (!providerState.selected) return;
    const usesChannels = providerState.selected.driverKind === "hermes";
    const promptText = usesChannels ? createChannelConfiguredPrompt(text, selectedChannels) : text;
    onSubmit(text, files, {
      displayText: text,
      ...(promptText === text ? {} : { promptText }),
      instanceId: providerState.selected.instanceId,
      model: providerState.selected.modelId,
      interactionMode: providerState.selected.interactionMode,
      permissionMode: providerState.selected.permissionMode,
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
    <div
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden bg-background"
      data-testid="web-chat-workspace"
      data-desktop-parity="true"
    >
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
      <ChatHistoryRail
        open={sidebarOpen}
        mobile={mobile}
        activeChatId={sessionId ?? null}
        conversations={conversations}
        onClose={() => setSidebarOpen(false)}
        onNewChat={onNewChat}
        onSwitchConversation={onSwitchConversation}
        onDeleteConversation={onDeleteConversation}
      />

      {/* Main content */}
      <main className="flex flex-1 flex-col min-w-0">
        {/* Top bar */}
        <header className={`flex items-center gap-2 border-b px-3 ${mobile ? "surface-glass min-h-14" : "min-h-12 border-border/30"}`}>
          {!sidebarOpen && (
            <>
              <Button
                variant="ghost"
                size="icon"
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
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                <BotIcon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 text-center">
                <p className="truncate text-sm font-semibold leading-4 text-foreground">
                  {providerState.activeInstance?.displayName ?? "Matrix Agent"}
                </p>
                <p className="truncate text-[10px] leading-3 text-muted-foreground">
                  {providerState.selected?.modelLabel ?? (providerState.loading ? "Loading AI access" : "AI access unavailable")}
                </p>
              </div>
            </div>
          </div>
          <Button
            variant={setupOpen ? "secondary" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => setSetupOpen((value) => !value)}
          >
            <Settings2Icon className="size-3.5" aria-hidden="true" />
            Setup
          </Button>
          {!connected && (
            <span className="text-[10px] text-destructive font-medium">Offline</span>
          )}
        </header>
        {setupOpen && (
          <ChatProviderSetupPanel
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
            lockedInstanceId={providerSelection?.instanceId}
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

        {/* Empty state or conversation */}
        {isEmpty ? (
          <EmptyState
            onSubmit={submitWithHermesSetup}
            connected={connected}
            mobile={mobile}
            composerDraftRequest={composerDraftRequest}
            onComposerDraftConsumed={onComposerDraftConsumed}
            modelLabel={providerState.selected?.modelLabel ?? null}
            providerReady={providerState.selected !== null}
            attachmentsEnabled={providerState.selected?.supportsFileAttachments ?? false}
          />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <Conversation>
              <ConversationContent className="mx-auto w-full max-w-[868px] gap-6 px-5 py-6">
                {grouped.map((group) => {
                  if (group.type === "tool_group") {
                    return <ToolCallGroup key={`tg-${group.messages[0].id}`} tools={group.messages} />;
                  }
                  const msg = group.message;
                  return (
                    <div key={msg.id}>
                      {msg.role === "user" ? (
                        <Message from="user">
                          <MessageContent>
                            <span className="whitespace-pre-wrap">{msg.content}</span>
                          </MessageContent>
                        </Message>
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
                    <AssistantBubble content={msg.content} onAction={submitWithHermesSetup} />
                      )}
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

            {/* Suggestions + Input */}
            <div className="mx-auto w-full max-w-[868px] px-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-2">
              {!busy && suggestions.length > 0 && (
                <div className="pb-3">
                  <SuggestionChips
                    suggestions={suggestions}
                    onSelect={(text) => submitWithHermesSetup(text)}
                  />
                </div>
              )}
              <ChatInput
                connected={connected && providerState.selected !== null}
                busy={busy}
                canAbort={canAbort}
                onSubmit={submitWithHermesSetup}
                onAbort={onAbort}
                draftRequest={composerDraftRequest}
                onDraftConsumed={onComposerDraftConsumed}
                unavailablePlaceholder={!providerState.loading && providerState.selected === null
                  ? "AI harness unavailable"
                  : undefined}
                attachmentsEnabled={providerState.selected?.supportsFileAttachments ?? false}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  onSubmit,
  connected,
  mobile,
  composerDraftRequest,
  onComposerDraftConsumed,
  modelLabel,
  providerReady,
  attachmentsEnabled,
}: {
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>) => void;
  connected: boolean;
  mobile: boolean;
  composerDraftRequest?: { id: number; text: string } | null;
  onComposerDraftConsumed?: (id: number) => void;
  modelLabel: string | null;
  providerReady: boolean;
  attachmentsEnabled: boolean;
}) {
  const [starterDraft, setStarterDraft] = useState<{ id: number; text: string } | null>(null);
  const starterSequence = useRef(0);
  const starters = [
    { label: "Explore and understand code", Icon: SearchIcon, tone: "text-success" },
    { label: "Build a new feature, app, or tool", Icon: Hammer, tone: "text-primary" },
    { label: "Review code and suggest changes", Icon: CircleCheck, tone: "text-success" },
    { label: "Fix issues and failures", Icon: Bug, tone: "text-warning" },
  ] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-8">
      <div className="w-full max-w-[868px] space-y-7">
        {/* Greeting */}
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-medium tracking-tight text-foreground/90">
            What should we build today?
          </h2>
          <p className="text-sm text-muted-foreground">
            {modelLabel ? `Using ${modelLabel}` : "Connect a harness in Settings to start chatting."}
          </p>
        </div>

        {/* Input */}
        <ChatInput
          connected={connected && providerReady}
          busy={false}
          canAbort={false}
          onSubmit={onSubmit}
          autoFocus={!mobile}
          draftRequest={composerDraftRequest ?? starterDraft}
          onDraftConsumed={(id) => {
            if (starterDraft?.id === id) setStarterDraft(null);
            onComposerDraftConsumed?.(id);
          }}
          unavailablePlaceholder={!providerReady ? "AI harness unavailable" : undefined}
          attachmentsEnabled={attachmentsEnabled}
        />

        <div className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-2"}`} data-slot="chat-starter-cards">
          {starters.map(({ label, Icon, tone }) => (
            <button
              key={label}
              type="button"
              onClick={() => setStarterDraft({ id: ++starterSequence.current, text: label })}
              className="flex min-h-28 flex-col items-start justify-between rounded-xl border border-border/60 bg-card p-4 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className={`flex size-8 items-center justify-center rounded-lg bg-muted/60 ${tone}`}>
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="max-w-44 text-[13px] font-medium leading-[18px] text-foreground">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({
  content,
  onAction,
}: {
  content: string;
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
      <MessageContent>
        {thinking && <Reasoning content={thinking} />}
        {planSteps && <Plan steps={planSteps} />}
        {taskData && <Task task={taskData} />}
        {displayContent && (
          <RichContent onAction={onAction}>{displayContent}</RichContent>
        )}
      </MessageContent>
    </Message>
  );
}

function ChatInput({
  connected,
  busy,
  canAbort,
  onSubmit,
  onAbort,
  autoFocus,
  draftRequest,
  onDraftConsumed,
  unavailablePlaceholder,
  attachmentsEnabled,
}: {
  connected: boolean;
  busy: boolean;
  canAbort: boolean;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>) => void;
  onAbort?: () => void;
  autoFocus?: boolean;
  draftRequest?: { id: number; text: string } | null;
  onDraftConsumed?: (id: number) => void;
  unavailablePlaceholder?: string;
  attachmentsEnabled: boolean;
}) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { attachments, addFiles, removeFile, clearAll, getBase64Files } = useAttachments();

  const {
    isRecording,
    isTranscribing,
    isSupported,
    startRecording,
    stopRecording,
  } = useVoice({
    onTranscription: (text) => setInput(text),
    onError: (err) => console.error("Voice error:", err),
  });

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- focusing a DOM ref when the composer mounts or autoFocus turns on is a legitimate effect, not a user-event side effect that belongs in a parent handler
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!draftRequest) return;
    setInput(draftRequest.text);
    textareaRef.current?.focus();
    onDraftConsumed?.(draftRequest.id);
  }, [draftRequest, onDraftConsumed]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    if (attachments.length > 0) {
      const files = await getBase64Files();
      onSubmit(text || `Attached ${files.length} file(s)`, files);
      clearAll();
    } else {
      onSubmit(text);
    }
    setInput("");
  };

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  return (
    <div className="flex flex-col gap-2">
      <Attachments attachments={attachments} onRemove={removeFile} />
      <div className="relative flex items-end rounded-2xl border border-border/60 bg-card/80 shadow-sm transition-shadow focus-within:shadow-md focus-within:border-border">
        <AttachmentButton
          onFilesSelected={addFiles}
          disabled={!connected || !attachmentsEnabled}
          title={attachmentsEnabled ? "Attach files" : "Attachments are unavailable for this harness"}
          className="mb-2.5 ml-3"
        />
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={
            isTranscribing ? "Transcribing..."
              : isRecording ? "Listening..."
                : connected ? "Ask anything..."
                  : unavailablePlaceholder ?? "Connecting..."
          }
          disabled={!connected || isRecording}
          rows={1}
          className="border-0 bg-transparent shadow-none focus-visible:ring-0 text-sm min-h-0 max-h-40 resize-none py-3 px-2 flex-1"
        />
        <div className="flex items-center gap-0.5 mb-2 mr-2">
          {isSupported && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={`size-8 rounded-full ${isRecording ? "text-red-500 animate-pulse" : "text-muted-foreground hover:text-foreground"}`}
              disabled={!connected || isTranscribing}
              onClick={handleMicClick}
            >
              {isTranscribing ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : isRecording ? (
                <MicOffIcon className="size-4" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </Button>
          )}
          {busy && canAbort && onAbort ? (
            <Button
              type="button"
              aria-label="Stop response"
              size="icon"
              className="size-8 rounded-full"
              onClick={onAbort}
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              aria-label="Send"
              size="icon"
              className="size-8 rounded-full"
              disabled={!connected || (!input.trim() && attachments.length === 0) || busy}
              onClick={() => handleSubmit()}
            >
              <SendIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
