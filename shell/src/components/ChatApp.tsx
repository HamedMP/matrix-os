"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
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
import { Reasoning, extractThinking } from "@/components/ai-elements/reasoning";
import { SuggestionChips, DEFAULT_SUGGESTIONS, parseSuggestions } from "@/components/ai-elements/suggestions";
import { Plan, parsePlan } from "@/components/ai-elements/plan";
import { Task, parseTask } from "@/components/ai-elements/task";
import { RichContent } from "@/components/ui-blocks";
import { ToolCallGroup } from "@/components/ToolCallGroup";
import { Attachments, AttachmentButton, useAttachments } from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useVoice } from "@/hooks/useVoice";
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
  MoreHorizontalIcon,
  TrashIcon,
} from "lucide-react";

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

interface ChatAppProps {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  conversations: ConversationMeta[];
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onSubmit: (text: string, files?: Array<{ name: string; type: string; data: string }>) => void;
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

  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

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
}: ChatAppProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const q = searchQuery.toLowerCase();
    return conversations.filter((c) => c.preview?.toLowerCase().includes(q));
  }, [conversations, searchQuery]);

  const timeGroups = useMemo(
    () => groupConversationsByTime(filteredConversations),
    [filteredConversations],
  );

  const suggestions = useMemo(() => {
    if (messages.length === 0) return DEFAULT_SUGGESTIONS;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && !m.tool);
    if (lastAssistant) {
      const parsed = parseSuggestions(lastAssistant.content);
      if (parsed.length > 0) return parsed;
    }
    return messages.length < 3 ? DEFAULT_SUGGESTIONS : [];
  }, [messages]);

  const isEmpty = messages.length === 0 && !busy;

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar */}
      <aside
        className={`flex flex-col border-r border-border/50 bg-muted/30 transition-all duration-200 ease-out ${
          sidebarOpen ? "w-[260px]" : "w-0 overflow-hidden"
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
        <header className="flex h-11 items-center gap-2 border-b border-border/30 px-3">
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
          <div className="flex-1" />
          <span className="text-xs font-medium text-foreground/60">Matrix OS</span>
          <div className="flex-1" />
          {!connected && (
            <span className="text-[10px] text-destructive font-medium">Offline</span>
          )}
        </header>

        {/* Empty state or conversation */}
        {isEmpty ? (
          <EmptyState onSubmit={onSubmit} connected={connected} suggestions={suggestions} />
        ) : (
          <div className="flex flex-1 flex-col min-h-0">
            <Conversation>
              <ConversationContent className="gap-5 px-4 py-6 md:px-0 mx-auto w-full max-w-[720px]">
                {grouped.map((group, i) => {
                  if (group.type === "tool_group") {
                    return <ToolCallGroup key={`tg-${i}`} tools={group.messages} />;
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
                        <AssistantBubble content={msg.content} onAction={onSubmit} />
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
            <div className="mx-auto w-full max-w-[720px] px-4 md:px-0 pb-4 pt-2">
              {!busy && suggestions.length > 0 && (
                <div className="pb-3">
                  <SuggestionChips
                    suggestions={suggestions}
                    onSelect={(text) => onSubmit(text)}
                  />
                </div>
              )}
              <ChatInput connected={connected} busy={busy} onSubmit={onSubmit} />
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
}: {
  onSubmit: (text: string) => void;
  connected: boolean;
  suggestions: string[];
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-[600px] space-y-8">
        {/* Greeting */}
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-medium tracking-tight text-foreground/90">
            What can I help you with?
          </h1>
        </div>

        {/* Input */}
        <ChatInput connected={connected} busy={false} onSubmit={onSubmit} autoFocus />

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((s, i) => (
              <button
                key={s}
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
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
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
    },
    [input, attachments, onSubmit, getBase64Files, clearAll],
  );

  const handleMicClick = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

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
