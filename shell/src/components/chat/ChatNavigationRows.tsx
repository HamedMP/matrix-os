"use client";

import type { ConversationMeta } from "@/hooks/useConversation";
import type { WebChatProject } from "@/lib/chat-projects";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  Folder,
  MoreHorizontal,
  PlusIcon,
  Trash2,
} from "@/lib/hugeicons";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

function conversationLabel(conversation: ConversationMeta): string {
  const preview = conversation.preview.trim();
  return preview ? `${preview.slice(0, 40)}${preview.length > 40 ? "…" : ""}` : "New chat";
}

export function ConversationRailRow({
  conversation,
  active,
  mobile,
  onSelect,
  onDelete,
}: {
  conversation: ConversationMeta;
  active: boolean;
  mobile: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const label = conversationLabel(conversation);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={`group/chat flex items-center rounded-lg ${active ? "bg-accent/50" : "hover:bg-accent/30"}`}>
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={onSelect}
            className={`min-w-0 flex-1 truncate px-2.5 text-left text-[13px] ${mobile ? "py-3" : "py-2"} ${active ? "text-foreground" : "text-foreground/70"}`}
          >
            {label}
          </button>
          <button
            type="button"
            aria-label={`Delete ${label}`}
            title={`Delete ${label}`}
            onClick={onDelete}
            className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/chat:opacity-100"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WebChatProjectRow({
  project,
  conversations,
  expanded,
  sessionId,
  mobile,
  onToggle,
  onNewChat,
  onSwitchConversation,
  onDeleteConversation,
  onRename,
  onDelete,
}: {
  project: WebChatProject;
  conversations: ConversationMeta[];
  expanded: boolean;
  sessionId?: string;
  mobile: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation: (conversation: ConversationMeta) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/project flex items-center rounded-lg hover:bg-accent/30">
            <button
              type="button"
              aria-label={project.name}
              aria-expanded={expanded}
              onClick={onToggle}
              className={`flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[13px] text-foreground/75 ${mobile ? "py-3" : "py-2"}`}
            >
              {expanded ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              <Folder className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{project.name}</span>
            </button>
            <button
              type="button"
              aria-label={`New chat in ${project.name}`}
              title={`New chat in ${project.name}`}
              onClick={onNewChat}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover/project:opacity-100"
            >
              <PlusIcon className="size-3.5" aria-hidden />
            </button>
            <DropdownMenuPrimitive.Root>
              <DropdownMenuPrimitive.Trigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${project.name} project`}
                  title={`Actions for ${project.name} project`}
                  className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover/project:opacity-100"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuPrimitive.Trigger>
              <DropdownMenuPrimitive.Portal>
                <DropdownMenuPrimitive.Content align="end" sideOffset={5} className="z-50 min-w-40 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                  <DropdownMenuPrimitive.Item onSelect={onRename} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent">
                    <Edit3 className="size-4" aria-hidden />
                    Rename
                  </DropdownMenuPrimitive.Item>
                  <DropdownMenuPrimitive.Item onSelect={onDelete} className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive outline-none data-[highlighted]:bg-destructive/10">
                    <Trash2 className="size-4" aria-hidden />
                    Delete
                  </DropdownMenuPrimitive.Item>
                </DropdownMenuPrimitive.Content>
              </DropdownMenuPrimitive.Portal>
            </DropdownMenuPrimitive.Root>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onRename}><Edit3 className="size-4" aria-hidden />Rename</ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={onDelete}><Trash2 className="size-4" aria-hidden />Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded ? (
        <div className="ml-4 border-l border-border/50 pl-1">
          {conversations.map((conversation) => (
            <ConversationRailRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === sessionId}
              mobile={mobile}
              onSelect={() => onSwitchConversation(conversation.id)}
              onDelete={() => onDeleteConversation(conversation)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
