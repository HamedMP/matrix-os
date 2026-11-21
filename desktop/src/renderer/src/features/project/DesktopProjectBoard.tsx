import { useMemo } from "react";
import {
  ProjectBoard, boardPreferencesKey, createHttpProjectBoardClient, isProjectBoardSlug, taskSessionTarget,
  type PreferenceStorage, type TaskSession,
} from "@matrix-os/ui/project-board";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
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

/**
 * Electron Desktop adapter for the shared project board: the gateway client
 * rides the selected computer's API client, chats open in this project's
 * Chat, and terminals in the Terminal app.
 */
export function DesktopProjectBoard({ project, active }: { project: Project; active: boolean }) {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const client = useMemo(() => {
    if (!api || !isProjectBoardSlug(project.slug)) return null;
    // Bound to one computer so a late response cannot land on another one.
    const gateway = api.forRuntime(runtimeSlot);
    const fetchGateway: typeof fetch = (input, init) => gateway.fetchGateway(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init,
    );
    return createHttpProjectBoardClient({ gatewayUrl: api.baseUrl, projectSlug: project.slug, fetch: fetchGateway });
  }, [api, runtimeSlot, project.slug]);
  const storage = useMemo(rendererStorage, []);

  const openSession = (session: TaskSession) => {
    const target = taskSessionTarget(session.ref);
    if (target?.kind === "chat") openWorkProject(project, target.chatId, session.title);
    else if (target?.kind === "terminal") openTerminalSession(`${target.workspaceId}:${target.tabId}`);
  };

  if (!client) {
    return <p role="alert" className="px-6 py-16 text-center text-[13px]" style={{ color: "var(--text-secondary)" }}>
      This project's board isn't available.
    </p>;
  }
  return <ProjectBoard key={`${runtimeSlot}:${project.slug}`} client={client} active={active} onOpenSession={openSession}
    preferencesKey={boardPreferencesKey("electron", project.id ?? project.slug)} storage={storage} />;
}
