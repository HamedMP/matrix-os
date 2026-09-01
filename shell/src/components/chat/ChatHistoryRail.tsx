"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessageSquareIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "@/lib/hugeicons";

export interface ChatConversationMeta {
  id: string;
  title?: string;
  preview: string;
  messageCount: number;
  updatedAt: number;
}

function conversationTitle(conversation: ChatConversationMeta): string {
  return conversation.title?.trim() || conversation.preview?.trim() || "New chat";
}

function activityLabel(timestamp: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}

export function ChatHistoryRail({
  open,
  mobile,
  activeChatId,
  conversations,
  onClose,
  onNewChat,
  onSwitchConversation,
  onDeleteConversation,
}: {
  open: boolean;
  mobile: boolean;
  activeChatId: string | null;
  conversations: ChatConversationMeta[];
  onClose: () => void;
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation?: (id: string) => Promise<boolean>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatConversationMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const trimmedSearch = searchQuery.trim();
  const filteredConversations = (!trimmedSearch
    ? conversations
    : conversations.filter((conversation) =>
        `${conversationTitle(conversation)} ${conversation.preview}`
          .toLowerCase()
          .includes(trimmedSearch.toLowerCase()),
      )).toSorted((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      <aside
        aria-label="Global chats"
        data-chat-rail={mobile ? "mobile" : "desktop"}
        className={`z-20 flex min-h-0 shrink-0 flex-col border-r border-border/60 bg-card transition-[width,transform] duration-200 ease-out ${
          open
            ? mobile ? "absolute inset-y-0 left-0 w-[min(86vw,320px)] shadow-2xl" : "w-[280px] min-w-[200px] max-w-[280px]"
            : "w-0 overflow-hidden"
        }`}
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-4">
          <div className="flex min-w-0 items-center gap-1.5">
            <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <h1 className="truncate text-base font-medium tracking-[-0.025em] text-foreground">Chat</h1>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search chats"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={() => setSearchOpen((value) => !value)}
            >
              <SearchIcon className="size-3.5" />
            </Button>
            <Button size="icon" aria-label="New chat" className="size-7 rounded-md" onClick={onNewChat}>
              <PlusIcon className="size-4" />
            </Button>
            {mobile ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close chat history"
                className="size-7 text-muted-foreground"
                onClick={onClose}
              >
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>

        {searchOpen ? (
          <div className="border-b border-border/50 p-3">
            <div className={`flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-xs ${mobile ? "py-2.5" : "py-2"}`}>
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input
                type="text"
                aria-label="Search chats"
                placeholder="Search chats"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
              />
            </div>
          </div>
        ) : null}

        <ScrollArea className="min-h-0 flex-1">
          <ul aria-label="Chat history" className="pb-4">
            {filteredConversations.map((conversation) => {
              const title = conversationTitle(conversation);
              return (
                <li key={conversation.id} className="group/chat relative border-b border-border/50">
                  <button
                    type="button"
                    aria-label={`${title} conversation`}
                    aria-current={conversation.id === activeChatId || undefined}
                    onClick={() => onSwitchConversation(conversation.id)}
                    className={`flex min-h-14 w-full min-w-0 items-center px-4 py-3 pr-24 text-left text-sm transition-colors ${
                      conversation.id === activeChatId
                        ? "bg-accent/70 text-foreground"
                        : "text-foreground hover:bg-accent/40"
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate leading-5">{title}</span>
                  </button>
                  <time
                    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xs text-muted-foreground transition-opacity group-hover/chat:opacity-0"
                    dateTime={new Date(conversation.updatedAt).toISOString()}
                  >
                    {activityLabel(conversation.updatedAt)}
                  </time>
                  {onDeleteConversation ? (
                    <button
                      type="button"
                      aria-label={`Delete ${title}`}
                      className="absolute right-3 top-1/2 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-md bg-card text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/chat:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteError(null);
                        setDeleteTarget(conversation);
                      }}
                    >
                      <Trash2Icon className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              );
            })}
            {conversations.length === 0 ? (
              <li className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                <span className="inline-flex size-9 items-center justify-center rounded-full bg-foreground/5 text-muted-foreground/60">
                  <MessageSquareIcon className="size-4" aria-hidden="true" />
                </span>
                <p className="text-xs text-muted-foreground/60">No chats yet.</p>
              </li>
            ) : null}
            {conversations.length > 0 && filteredConversations.length === 0 ? (
              <li className="px-4 py-6 text-center text-xs text-muted-foreground">No chats match that search.</li>
            ) : null}
          </ul>
        </ScrollArea>
      </aside>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deleting) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent role="alertdialog" showCloseButton={!deleting} className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget ? conversationTitle(deleteTarget) : "chat"}?</DialogTitle>
            <DialogDescription>
              This permanently deletes this chat and its messages. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => {
                setDeleteTarget(null);
                setDeleteError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleting || !deleteTarget || !onDeleteConversation}
              onClick={() => {
                if (!deleteTarget || !onDeleteConversation || deleting) return;
                setDeleting(true);
                setDeleteError(null);
                void onDeleteConversation(deleteTarget.id).then((deleted) => {
                  if (deleted) setDeleteTarget(null);
                  else setDeleteError("The Chat could not be deleted. Try again.");
                }).finally(() => setDeleting(false));
              }}
            >
              {deleting ? "Deleting chat" : "Delete chat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
