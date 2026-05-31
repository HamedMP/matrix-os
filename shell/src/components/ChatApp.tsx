"use client";

import { useState, useMemo, useRef, useEffect } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useVoice } from "@/hooks/useVoice";
import {
  DEFAULT_HERMES_MODEL,
  DEFAULT_HERMES_CHANNELS,
  createHermesConfiguredPrompt,
} from "./chat-app-hermes";
import {
  LoaderCircleIcon,
  PlusIcon,
  SendIcon,
  MicIcon,
  MicOffIcon,
  Loader2Icon,
  SparklesIcon,
  PanelLeftIcon,
  SearchIcon,
  MessageSquareIcon,
  BotIcon,
  CalendarIcon,
  CheckIcon,
  GithubIcon,
  MailIcon,
  Settings2Icon,
} from "lucide-react";

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

const HERMES_SETUP_STORAGE_KEY = "matrix:hermes-setup";

function readHermesSetup() {
  if (typeof window === "undefined") {
    return { model: DEFAULT_HERMES_MODEL, channels: DEFAULT_HERMES_CHANNELS };
  }
  try {
    const raw = window.localStorage.getItem(HERMES_SETUP_STORAGE_KEY);
    if (!raw) return { model: DEFAULT_HERMES_MODEL, channels: DEFAULT_HERMES_CHANNELS };
    const parsed = JSON.parse(raw) as { model?: unknown; channels?: unknown };
    return {
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : DEFAULT_HERMES_MODEL,
      channels: Array.isArray(parsed.channels)
        ? parsed.channels.filter((channel): channel is string => typeof channel === "string").slice(0, 8)
        : DEFAULT_HERMES_CHANNELS,
    };
  } catch (err: unknown) {
    console.warn("[chat] Failed to load Hermes setup:", err instanceof Error ? err.message : String(err));
    return { model: DEFAULT_HERMES_MODEL, channels: DEFAULT_HERMES_CHANNELS };
  }
}

function writeHermesSetup(model: string, channels: string[]) {
  try {
    window.localStorage.setItem(HERMES_SETUP_STORAGE_KEY, JSON.stringify({ model, channels }));
  } catch (err: unknown) {
    console.warn("[chat] Failed to save Hermes setup:", err instanceof Error ? err.message : String(err));
  }
}

interface ChatAppProps {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  conversations: ConversationMeta[];
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onSubmit: (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
    options?: { displayText?: string; promptText?: string },
  ) => void;
  mobile?: boolean;
}

function groupConversationsByTime(conversations: ConversationMeta[]) {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const weekMs = todayMs - 7 * 86_400_000;

  const groups: { label: string; items: ConversationMeta[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];

  const sorted = conversations.toSorted((a, b) => b.updatedAt - a.updatedAt);

  for (const conv of sorted) {
    if (conv.updatedAt >= todayMs) groups[0].items.push(conv);
    else if (conv.updatedAt >= yesterdayMs) groups[1].items.push(conv);
    else if (conv.updatedAt >= weekMs) groups[2].items.push(conv);
    else groups[3].items.push(conv);
  }

  return groups.filter((g) => g.items.length > 0);
}

export function ChatApp({
  messages,
  sessionId,
  busy,
  connected,
  conversations,
  onNewChat,
  onSwitchConversation,
  onSubmit,
  mobile = false,
  // react-doctor-disable-next-line react-doctor/prefer-useReducer -- these useState fields (sidebarOpen, searchQuery, setupOpen, model, channels) are independent UI concerns with separate update sites and lifecycles, not one related state machine; collapsing them into a reducer would couple unrelated transitions and is not a mechanical, behavior-identical change.
}: ChatAppProps) {
  const [sidebarOpen, setSidebarOpen] = useState(!mobile);
  const [searchQuery, setSearchQuery] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const initialHermesSetupRef = useRef<ReturnType<typeof readHermesSetup> | null>(null);
  const getInitialHermesSetup = () => {
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot yet lower the `??=` logical-assignment operator (BuildHIR Todo); this lazy one-time ref cache is a deliberate first-render localStorage read and rewriting it would not change behavior.
    initialHermesSetupRef.current ??= readHermesSetup();
    return initialHermesSetupRef.current;
  };
  // react-doctor-disable-next-line react-hooks-js/refs -- the ref read happens inside a lazy useState initializer (first render only); initialHermesSetupRef caches the one-time localStorage read so both useState initializers share a single readHermesSetup() result without re-reading storage.
  const [model, setModel] = useState(() => getInitialHermesSetup().model);
  // react-doctor-disable-next-line react-hooks-js/refs -- lazy useState initializer reading the same one-time cached Hermes setup (see model above); ref read is first-render-only.
  const [channels, setChannels] = useState(() => new Set(getInitialHermesSetup().channels));
  const grouped = groupMessages(messages);
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is consumed by the writeHermesSetup useEffect dependency array below; keep an explicit useMemo so the persisted-setup effect only re-runs when the channel set actually changes, not on every render.
  const selectedChannels = useMemo(() => Array.from(channels).sort(), [channels]);
  useEffect(() => {
    writeHermesSetup(model, selectedChannels);
  }, [model, selectedChannels]);
  const submitWithHermesSetup = (
    text: string,
    files?: Array<{ name: string; type: string; data: string }>,
  ) => {
    const promptText = createHermesConfiguredPrompt(text, model, selectedChannels);
    onSubmit(text, files, promptText === text ? { displayText: text } : { displayText: text, promptText });
  };

  const trimmedSearch = searchQuery.trim();
  const filteredConversations = !trimmedSearch
    ? conversations
    : conversations.filter((c) =>
        c.preview?.toLowerCase().includes(searchQuery.toLowerCase()),
      );

  const timeGroups = groupConversationsByTime(filteredConversations);

  const suggestions = getMessageSuggestions(messages);

  const isEmpty = messages.length === 0 && !busy;

  return (
    <div className="relative flex h-full bg-background">
      {/* Sidebar */}
      <aside
        className={`z-20 flex flex-col border-r border-border/50 bg-muted/95 backdrop-blur transition-all duration-200 ease-out ${
          sidebarOpen
            ? mobile ? "absolute inset-y-0 left-0 w-[min(86vw,320px)] shadow-2xl" : "w-[260px]"
            : "w-0 overflow-hidden"
        }`}
      >
        <div className="flex items-center justify-between p-3 pb-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={onNewChat}
            title="New chat"
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-lg bg-background/60 px-2.5 py-1.5 text-xs">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              aria-label="Search chats"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60 text-foreground"
            />
          </div>
        </div>

        {/* Conversation list */}
        <ScrollArea className="flex-1">
          <div className="px-2 pb-3">
            {timeGroups.map((group) => (
              <div key={group.label}>
                <div className="px-2 pt-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {group.label}
                </div>
                {group.items.map((conv) => (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => onSwitchConversation(conv.id)}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                      conv.id === sessionId
                        ? "bg-accent/50 text-foreground"
                        : "text-foreground/70 hover:bg-accent/30 hover:text-foreground"
                    }`}
                  >
                    <span className="flex-1 truncate">
                      {conv.preview
                        ? conv.preview.slice(0, 40) + (conv.preview.length > 40 ? "..." : "")
                        : "New chat"}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {conversations.length === 0 && (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground/50">
                No conversations yet
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Main content */}
      <main className="flex flex-1 flex-col min-w-0">
        {/* Top bar */}
        <header className="flex min-h-12 items-center gap-2 border-b border-border/30 px-3">
          {!sidebarOpen && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={() => setSidebarOpen(true)}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
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
                <p className="truncate text-sm font-semibold leading-4 text-foreground">Hermes</p>
                <p className="truncate text-[10px] leading-3 text-muted-foreground">Matrix system agent</p>
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
          <HermesSetupPanel
            model={model}
            onModelChange={setModel}
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
            suggestions={suggestions}
            mobile={mobile}
            model={model}
          />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <Conversation>
              <ConversationContent className="gap-5 px-4 py-5 md:px-0 mx-auto w-full max-w-[720px]">
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
                        <div className="text-xs px-3 py-1.5 rounded-md bg-muted/50 text-muted-foreground">
                          {msg.content}
                        </div>
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
            <div className="mx-auto w-full max-w-[720px] px-3 md:px-0 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2">
              {!busy && suggestions.length > 0 && (
                <div className="pb-3">
                  <SuggestionChips
                    suggestions={suggestions}
                    onSelect={(text) => submitWithHermesSetup(text)}
                  />
                </div>
              )}
              <ChatInput connected={connected} busy={busy} onSubmit={submitWithHermesSetup} />
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
  suggestions,
  mobile,
  model,
}: {
  onSubmit: (text: string) => void;
  connected: boolean;
  suggestions: string[];
  mobile: boolean;
  model: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-[600px] space-y-8">
        {/* Greeting */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-medium tracking-tight text-foreground/90">
            What should Hermes do?
          </h1>
          <p className="text-sm text-muted-foreground">Using {model}</p>
        </div>

        {/* Input */}
        <ChatInput connected={connected} busy={false} onSubmit={onSubmit} autoFocus={!mobile} />

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => onSubmit(s)}
                className="rounded-full border border-border/60 bg-card/50 px-3.5 py-1.5 text-xs text-foreground/70 transition-all hover:bg-accent/40 hover:text-foreground hover:border-border"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const HERMES_MODELS = ["Hermes default", "Claude specialist", "Codex coding", "Bring your own"];
const HERMES_CHANNEL_OPTIONS = [
  { id: "shell", label: "Shell", icon: MessageSquareIcon },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "github", label: "GitHub", icon: GithubIcon },
];

function HermesSetupPanel({
  model,
  onModelChange,
  channels,
  onToggleChannel,
}: {
  model: string;
  onModelChange: (model: string) => void;
  channels: Set<string>;
  onToggleChannel: (channel: string) => void;
}) {
  const models = HERMES_MODELS;
  const channelOptions = HERMES_CHANNEL_OPTIONS;

  return (
    <section className="border-b border-border/30 bg-muted/30 px-3 py-3">
      <div className="mx-auto grid w-full max-w-[720px] gap-3 md:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Model</p>
          <div className="grid grid-cols-2 gap-1.5">
            {models.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onModelChange(option)}
                className={`flex min-h-9 items-center justify-between rounded-md border px-2.5 text-left text-xs transition ${
                  model === option
                    ? "border-primary/35 bg-primary/10 text-foreground"
                    : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="truncate">{option}</span>
                {model === option && <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Channels</p>
          <div className="grid grid-cols-2 gap-1.5">
            {channelOptions.map((option) => {
              const Icon = option.icon;
              const selected = channels.has(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onToggleChannel(option.id)}
                  className={`flex min-h-9 items-center gap-2 rounded-md border px-2.5 text-xs transition ${
                    selected
                      ? "border-primary/35 bg-primary/10 text-foreground"
                      : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
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
  onSubmit,
  autoFocus,
}: {
  connected: boolean;
  busy: boolean;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>) => void;
  autoFocus?: boolean;
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

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
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
          disabled={!connected}
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
                  : "Connecting..."
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
          <Button
            type="button"
            size="icon"
            className="size-8 rounded-full"
            disabled={!connected || (!input.trim() && attachments.length === 0) || busy}
            onClick={() => handleSubmit()}
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
