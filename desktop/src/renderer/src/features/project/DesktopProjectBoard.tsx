import { useMemo } from "react";
import {
  ProjectBoard, TicketHeader, boardPreferencesKey, createHttpProjectBoardClient, isProjectBoardSlug, taskSessionTarget, useChatTicket,
  type PreferenceStorage, type ProjectBoardClient, type TaskSession,
} from "@matrix-os/ui/project-board";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { openProjectBoard, useBoardDetailsRequest } from "../../lib/project-navigation";
import { openTerminalSession } from "../mission-control/navigation-roots";
import { openWorkProject } from "../work/work-navigation";

/** Board layout and filters stay in this renderer, beside the other per-viewer presentation choices. */
function rendererStorage(): PreferenceStorage | undefined {
  try {
    return window.localStorage;
  } catch (error: unknown) {
    console.warn("[project-board] preference storage unavailable:", error instanceof Error ? error.name : typeof error);
    return undefined;
  }
}

/** The project's board client over the selected computer's API client; null when the project has no board. */
function useDesktopBoardClient(project: Project | undefined): { client: ProjectBoardClient | null; runtimeSlot: unknown } {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const slug = project?.slug;
  const client = useMemo(() => {
    if (!api || !slug || !isProjectBoardSlug(slug)) return null;
    // Bound to one computer so a late response cannot land on another one.
    const gateway = api.forRuntime(runtimeSlot);
    const fetchGateway: typeof fetch = (input, init) => gateway.fetchGateway(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init,
    );
    return createHttpProjectBoardClient({ gatewayUrl: api.baseUrl, projectSlug: slug, fetch: fetchGateway });
  }, [api, runtimeSlot, slug]);
  return { client, runtimeSlot };
}

function openTaskTerminal(session: TaskSession | null): void {
  const target = session ? taskSessionTarget(session.ref) : null;
  if (target) openTerminalSession(`${target.workspaceId}:${target.tabId}`);
}

/**
 * Electron Desktop adapter for the shared project board: cards open their
 * task's chat in this project's Chat (every task is a chat), and terminals
 * open in the Terminal app.
 */
export function DesktopProjectBoard({ project, active }: { project: Project; active: boolean }) {
  const { client, runtimeSlot } = useDesktopBoardClient(project);
  const storage = useMemo(rendererStorage, []);
  const detailsTaskId = useBoardDetailsRequest((s) => s.request?.projectSlug === project.slug ? s.request.taskId : null);

  if (!client) {
    return <p role="alert" className="px-6 py-16 text-center text-[13px]" style={{ color: "var(--text-secondary)" }}>
      This project's board isn't available.
    </p>;
  }
  return <ProjectBoard key={`${String(runtimeSlot)}:${project.slug}`} client={client} active={active} onOpenSession={openTaskTerminal}
    onOpenChat={(task) => { if (task.chatId) openWorkProject(project, task.chatId, task.title); }} detailsTaskId={detailsTaskId}
    preferencesKey={boardPreferencesKey("electron", project.id ?? project.slug)} storage={storage} />;
}

/** A project chat's ticket above its conversation, editable in place; nothing for a chat without one. */
export function DesktopChatTicketBar({ project, chatId }: { project: Project; chatId: string }) {
  const { client } = useDesktopBoardClient(project);
  const ticket = useChatTicket(client, client ? chatId : null);
  if (!ticket.task) return null;
  const task = ticket.task;
  return <div data-slot="chat-ticket-bar">
    <TicketHeader task={task} members={ticket.members} busy={ticket.busy}
      onUpdate={(input) => void ticket.update(input)} onStatusChange={(status) => void ticket.setStatus(status)}
      onOpenDetails={() => openProjectBoard(project.slug, project.name || project.slug, task.id)}
      onStartTerminal={() => void ticket.startTerminal().then(openTaskTerminal)} />
    {ticket.notice ? <p role="status" className="border-b px-3 py-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>{ticket.notice}</p> : null}
  </div>;
}
