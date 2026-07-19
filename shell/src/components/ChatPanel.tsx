"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LoaderCircleIcon,
  PlusIcon,
  PanelRightCloseIcon,
  MicIcon,
  Volume2Icon,
} from "lucide-react";

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

interface ChatPanelDragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const CHAT_PANEL_DRAG_BREAKPOINT = 768;

export interface ChatPanelProps {
  messages: ChatMessage[];
  sessionId: string | undefined;
  busy: boolean;
  connected: boolean;
  conversations: ConversationMeta[];
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onClose: () => void;
  onSubmit?: (text: string) => void;
  inputBar?: React.ReactNode;
}

export function ChatPanel({
  messages,
  sessionId,
  busy,
  connected,
  conversations,
  onNewChat,
  onSwitchConversation,
  onClose,
  onSubmit,
  inputBar,
}: ChatPanelProps) {
  const [panelOffset, setPanelOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<ChatPanelDragState | null>(null);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      setPanelOffset({
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY,
      });
    };
    const handlePointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= CHAT_PANEL_DRAG_BREAKPOINT) return;

      dragRef.current = null;
      setPanelOffset((current) => (
        current.x || current.y
          ? { x: 0, y: 0 }
          : current
      ));
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (window.innerWidth < CHAT_PANEL_DRAG_BREAKPOINT) return;

    const target = event.target as HTMLElement;
    if (target.closest("button,a,input,textarea,select,[role='combobox']")) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: panelOffset.x,
      originY: panelOffset.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const panelTransform = panelOffset.x || panelOffset.y
    ? `translate3d(${panelOffset.x}px, ${panelOffset.y}px, 0)`
    : undefined;

  return (
    <aside
      data-testid="chat-panel"
      className="flex fixed inset-0 z-50 w-full flex-col border-l border-border bg-card md:inset-y-0 md:left-auto md:right-0 md:w-[400px] md:shadow-2xl"
      style={{ transform: panelTransform }}
    >
      <header
        data-testid="chat-panel-drag-handle"
        className="flex items-center justify-between px-4 py-3"
        onPointerDown={handleDragStart}
        style={{ cursor: "move", touchAction: "none" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">History</span>
          {conversations.length > 1 && (
            <Select
              value={sessionId ?? ""}
              onValueChange={(id) => {
                if (id !== null) onSwitchConversation(id);
              }}
            >
              <SelectTrigger size="sm" className="h-6 text-xs w-[130px]">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {conversations
                  .toSorted((a, b) => b.updatedAt - a.updatedAt)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      {c.preview
                        ? c.preview.slice(0, 30) + (c.preview.length > 30 ? "..." : "")
                        : c.id.slice(0, 12)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon" className="size-6" onClick={onNewChat}>
            <PlusIcon className="size-3.5" />
          </Button>
          <Badge variant={connected ? "default" : "destructive"} className="text-xs">
            <span className={`size-1.5 rounded-full ${connected ? "bg-success" : "bg-current"}`} />
            {connected ? "Connected" : "Offline"}
          </Badge>
          <Button variant="ghost" size="icon" className="size-6" onClick={onClose}>
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
        </div>
      </header>
      <Separator />

      <Conversation>
        <ConversationContent className="gap-4 px-4 py-3">
          {groupMessages(messages).map((group) => {
            if (group.type === "tool_group") {
              return <ToolCallGroup key={`tg-${group.messages[0].id}`} tools={group.messages} />;
            }
            const msg = group.message;
            const isVoice = msg.metadata?.source === "voice";
            return (
              <div key={msg.id}>
                {msg.role === "user" ? (
                  <Message from="user">
                    <MessageContent>
                      {isVoice && (
                        <MicIcon className="inline-block size-3.5 mr-1.5 text-muted-foreground align-text-bottom" />
                      )}
                      <span className="whitespace-pre-wrap">{msg.content}</span>
                    </MessageContent>
                  </Message>
                ) : msg.role === "system" ? (
                  <div className="text-xs px-3 py-1 rounded bg-background text-muted-foreground">
                    {msg.content}
                  </div>
                ) : (
                  <AssistantMessage
                    content={msg.content}
                    onAction={onSubmit}
                    hasVoiceAudio={isVoice && msg.metadata?.hasAudio === true}
                  />
                )}
              </div>
            );
          })}

          {busy && (
            <div className="flex items-center gap-2 text-xs px-3 py-1 text-muted-foreground">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Thinking...
            </div>
          )}

          {!busy && onSubmit && (
            <ChatSuggestions messages={messages} onSelect={onSubmit} />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      {inputBar && (
        <div className="border-t border-border p-3">
          {inputBar}
        </div>
      )}
    </aside>
  );
}

function AssistantMessage({
  content,
  onAction,
  hasVoiceAudio,
}: {
  content: string;
  onAction?: (text: string) => void;
  hasVoiceAudio?: boolean;
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
        {hasVoiceAudio && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            title="Play audio response"
          >
            <Volume2Icon className="size-3.5" />
            Play
          </Button>
        )}
      </MessageContent>
    </Message>
  );
}

function ChatSuggestions({
  messages,
  onSelect,
}: {
  messages: ChatMessage[];
  onSelect: (text: string) => void;
}) {
  const suggestions = getMessageSuggestions(messages);

  if (suggestions.length === 0) return null;

  return <SuggestionChips suggestions={suggestions} onSelect={onSelect} />;
}
