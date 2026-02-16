"use client";

import type { ChatMessage } from "@/lib/chat";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { RichContent } from "@/components/ui-blocks";
import { Tool } from "@/components/ai-elements/tool";
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
  WrenchIcon,
  CheckCircleIcon,
  LoaderCircleIcon,
  PlusIcon,
  PanelRightCloseIcon,
} from "lucide-react";

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

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

function ToolMessage({ msg }: { msg: ChatMessage }) {
  const isRunning = msg.content.startsWith("Using ");

  return (
    <Tool>
      <div className="flex w-full items-center gap-2 p-3">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{msg.tool}</span>
        {isRunning ? (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <CheckCircleIcon className="size-4 text-green-600" />
        )}
      </div>
    </Tool>
  );
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
  return (
    <aside className="flex fixed inset-0 z-50 w-full flex-col border-l border-border bg-card md:inset-y-0 md:left-auto md:right-0 md:w-[400px] md:shadow-2xl">
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">History</span>
          {conversations.length > 1 && (
            <Select value={sessionId ?? ""} onValueChange={onSwitchConversation}>
              <SelectTrigger size="sm" className="h-6 text-xs w-[130px]">
                <SelectValue placeholder="Select..." />
              </SelectTrigger>
              <SelectContent>
                {[...conversations]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
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
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === "user" ? (
                <Message from="user">
                  <MessageContent>{msg.content}</MessageContent>
                </Message>
              ) : msg.tool ? (
                <ToolMessage msg={msg} />
              ) : msg.role === "system" ? (
                <div className="text-xs px-3 py-1 rounded bg-background text-muted-foreground">
                  {msg.content}
                </div>
              ) : (
                <Message from="assistant">
                  <MessageContent>
                    <RichContent onAction={onSubmit}>{msg.content}</RichContent>
                  </MessageContent>
                </Message>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs px-3 py-1 text-muted-foreground">
              <LoaderCircleIcon className="size-3 animate-spin" />
              Thinking...
            </div>
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
