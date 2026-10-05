import { CollaborationDiscoveryItemSchema, type CollaborationProjectOverview } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { subscribeCollaborationDiscoveryChanged, type CollaborationDirectApi } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { Folder, FolderOpen, MessageSquare, UsersIcon } from "@renderer/lib/hugeicons";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../../lib/collaboration";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";

const REFRESH_MS = 30_000;
const SHARED_PAGE = "/api/collaboration/shared?limit=50";
/** Most pages of shared items read per refresh; 50 items each. */
const MAX_SHARED_PAGES = 20;
/** The page is only bounded here; each item is validated on its own below. */
const SharedPageSchema = z.looseObject({
  items: z.array(z.unknown()).max(100),
  nextCursor: z.string().min(1).max(1_024).optional(),
});

/** The shared projects on one page; one item a client could not describe never hides the rest. */
function projectsOnPage(items: unknown[]): CollaborationProjectOverview[] {
  return items.flatMap((raw) => {
    const item = CollaborationDiscoveryItemSchema.safeParse(raw);
    if (!item.success) {
      console.warn("[work-rail] shared project skipped", item.error.name);
      return [];
    }
    const resource = item.data.status === "accepted" ? item.data.resource : undefined;
    return resource && "project" in resource && resource.overview ? [resource.overview] : [];
  });
}

async function loadSharedProjects(api: CollaborationDirectApi): Promise<CollaborationProjectOverview[]> {
  const projects: CollaborationProjectOverview[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_SHARED_PAGES; page += 1) {
    const path = cursor ? `${SHARED_PAGE}&cursor=${encodeURIComponent(cursor)}` : SHARED_PAGE;
    const value = SharedPageSchema.parse(await api.get(path));
    projects.push(...projectsOnPage(value.items));
    if (!value.nextCursor) break;
    cursor = value.nextCursor;
  }
  return projects;
}

/**
 * Accepted shared projects whose owner's home described them. Each sign-in gets its own client
 * (a sign-in change closes the previous one), and a change that arrives during a load is not lost:
 * it runs one more load when the current one settles.
 */
function useSharedProjects(): CollaborationProjectOverview[] {
  const actorId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [projects, setProjects] = useState<CollaborationProjectOverview[]>([]);
  useEffect(() => {
    let current = true;
    let inFlight = false;
    let again = false;
    setProjects([]);
    const api = actorId ? createDesktopCollaborationApi(platformHost) : null;
    if (!api) return () => { current = false; };
    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        const next = await loadSharedProjects(api);
        if (current) setProjects(next);
      } catch (error: unknown) {
        console.warn("[work-rail] shared projects unavailable", error instanceof Error ? error.name : "UnknownError");
        if (current) setProjects([]);
      } finally {
        inFlight = false;
      }
      if (again && current) {
        again = false;
        await load();
      }
    };
    void load();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(() => void load());
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      current = false;
      unsubscribe();
      clearInterval(timer);
      releaseDesktopCollaborationApi(api);
    };
  }, [actorId, platformHost, authGeneration]);
  return projects;
}

/**
 * Shared projects in the Work rail, shown like the member's own projects with one shared mark.
 * Owner actions (pin, edit, share, delete, new Chat) are absent; Chats open as shared Chat tabs.
 */
export function SharedWorkRailProjects() {
  const projects = useSharedProjects();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const activeSharedScope = useTabs((state) => state.tabs.find((tab) => tab.id === state.activeTabId)?.sharedScopeId);
  if (projects.length === 0) return null;
  return <>
    {projects.map((project) => {
      const open = Boolean(expanded[project.scopeId]);
      const active = project.chats.some((chat) => chat.scopeId === activeSharedScope);
      return <div key={project.scopeId}>
        <div className="group/project relative flex min-w-0 items-center rounded-md hover:bg-[var(--bg-hover)]">
          <button
            type="button"
            aria-label={project.name}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: active ? "var(--text-primary)" : "var(--text-secondary)" }}
            onClick={() => setExpanded((current) => ({ ...current, [project.scopeId]: !open }))}
          >
            {open
              ? <FolderOpen size={15} aria-hidden className="shrink-0" style={{ color: active ? "var(--accent)" : "var(--text-tertiary)" }} />
              : <Folder size={15} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />}
            <span className="truncate">{project.name}</span>
            <span role="img" aria-label="Shared project" title="Shared with you" className="ml-auto flex shrink-0" style={{ color: "var(--text-tertiary)" }}>
              <UsersIcon size={13} aria-hidden />
            </span>
          </button>
        </div>
        {open ? <div className="flex flex-col gap-0.5 pl-5">
          {project.chats.map((chat) => {
            const current = chat.scopeId === activeSharedScope;
            return <button
              key={chat.scopeId}
              type="button"
              aria-label={chat.title}
              aria-current={current ? "page" : undefined}
              className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
              style={{ color: current ? "var(--text-primary)" : "var(--text-secondary)" }}
              onClick={() => useTabs.getState().openTab({
                kind: "chat",
                title: chat.title,
                chatTitle: chat.title,
                chatView: "conversation",
                chatId: chat.chatId,
                sharedScopeId: chat.scopeId,
                closable: false,
              })}
            >
              <MessageSquare size={15} aria-hidden className="shrink-0" style={{ color: current ? "var(--accent)" : "var(--text-tertiary)" }} />
              <span className="min-w-0 flex-1 truncate">{chat.title}</span>
            </button>;
          })}
        </div> : null}
      </div>;
    })}
  </>;
}
