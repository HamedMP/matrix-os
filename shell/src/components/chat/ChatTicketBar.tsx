"use client";

import { useMemo } from "react";
import { TicketHeader, createHttpProjectBoardClient, isProjectBoardSlug, taskSessionTarget, useChatTicket, type ProjectTask } from "@matrix-os/ui/project-board";
import { openTerminalSession } from "@/lib/terminal-session-open";
import type { WebProject } from "./web-projects";

/**
 * Every task is a chat: a project chat shows its ticket above the conversation,
 * editable in place. Renders nothing for chats outside a project.
 */
export function ChatTicketBar({ gatewayUrl, project, chatId, onOpenDetails }: {
  gatewayUrl: string;
  project: WebProject | undefined;
  chatId: string;
  onOpenDetails(project: WebProject, task: ProjectTask): void;
}) {
  const client = useMemo(() => project && isProjectBoardSlug(project.slug) ? createHttpProjectBoardClient({ gatewayUrl, projectSlug: project.slug }) : null,
    [gatewayUrl, project]);
  const ticket = useChatTicket(client, client ? chatId : null);
  if (!project || !ticket.task) return null;
  const task = ticket.task;
  return <div data-slot="chat-ticket-bar">
    <TicketHeader task={task} members={ticket.members} busy={ticket.busy}
      onUpdate={(input) => void ticket.update(input)} onStatusChange={(status) => void ticket.setStatus(status)}
      onOpenDetails={() => onOpenDetails(project, task)}
      onStartTerminal={() => void ticket.startTerminal().then((session) => {
        const target = session ? taskSessionTarget(session.ref) : null;
        if (target) openTerminalSession(`${target.workspaceId}:${target.tabId}`);
      })} />
    {ticket.notice ? <p role="status" className="border-b px-3 py-1 text-[12px] text-muted-foreground">{ticket.notice}</p> : null}
  </div>;
}
