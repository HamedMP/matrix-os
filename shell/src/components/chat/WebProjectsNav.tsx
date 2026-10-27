"use client";

import { ChatRailSection, OverflowingChatTitle } from "@matrix-os/ui";
import { useAuth } from "@clerk/nextjs";
import { Folder, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod/v4";

const ProjectsResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  })),
});
type Project = z.infer<typeof ProjectsResponseSchema>["projects"][number];
type ProjectSnapshot = { identity: string; projects: Project[] };
async function loadProjects(gatewayUrl: string, signal: AbortSignal): Promise<Project[]> {
  const response = await fetch(`${gatewayUrl}/api/workspace/projects`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("ProjectsUnavailable");
  return ProjectsResponseSchema.parse(await response.json()).projects;
}
const ProjectChatsResponseSchema = z.object({
  items: z.array(z.object({ chat: z.object({ id: z.string().min(1), title: z.string().min(1) }) })).max(100),
  nextCursor: z.string().regex(/^chatcur_[A-Za-z0-9_-]+$/).max(512).optional(),
});
type ProjectChat = { id: string; title: string };
async function loadProjectChats(gatewayUrl: string, projectId: string, cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ projectId, limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`${gatewayUrl}/api/chats?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("ProjectChatsUnavailable");
  return ProjectChatsResponseSchema.parse(await response.json());
}

function WebProjectChats({ gatewayUrl, projectId, activeChatId, onSelectChat, mobile }: {
  gatewayUrl: string; projectId: string; activeChatId?: string; onSelectChat(chatId: string): void; mobile: boolean;
}) {
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [chats, setChats] = useState<ProjectChat[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);

  // Each page is owner-filtered by the gateway and scoped to this project.
  // Unmounting on collapse or an authority change aborts its pending request.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the current computer's owner-scoped chats are only available at runtime.
  useEffect(() => {
    const controller = new AbortController();
    void loadProjectChats(gatewayUrl, projectId, pageCursor, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const page = result.items.map(item => ({ id: item.chat.id, title: item.chat.title }));
      setChats(previous => pageCursor === null ? page : [
        ...previous,
        ...page.filter(item => !previous.some(existing => existing.id === item.id)),
      ]);
      setNextCursor(result.nextCursor);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] chats unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [gatewayUrl, projectId, pageCursor, retry]);

  return <div className="ml-4 border-l border-border pl-2">
    {chats.map(chat => <button key={chat.id} type="button"
      aria-current={activeChatId === chat.id ? "page" : undefined}
      className={`w-full truncate rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
      onClick={() => onSelectChat(chat.id)}>{chat.title}</button>)}
    {loading ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading chats…</p> : null}
    {error ? <div className="px-2 py-2 text-xs text-muted-foreground">
      <p role="alert">Project chats could not be loaded.</p>
      <button type="button" className={`mt-1 rounded px-2 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
        onClick={() => { setLoading(true); setError(false); setRetry(value => value + 1); }}>Retry chats</button>
    </div> : null}
    {!loading && !error && chats.length === 0 ? <div className="space-y-1 px-2 py-3 text-xs text-muted-foreground">
      <MessageSquare aria-hidden="true" size={16} strokeWidth={1.5} />
      <p className="font-medium text-foreground">No chats to show here.</p>
      <p>Conversations saved to this project will appear here.</p>
      <p>Add one from Matrix Desktop.</p>
    </div> : null}
    {!loading && !error && nextCursor ? <button type="button"
      className={`w-full rounded px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
      onClick={() => { setLoading(true); setPageCursor(nextCursor); }}>Load more chats</button> : null}
  </div>;
}

export function WebProjectsNav({ gatewayUrl, scopeKey, activeChatId, onSelectChat, mobile = false }: {
  gatewayUrl: string;
  scopeKey: string;
  activeChatId?: string;
  onSelectChat(chatId: string): void;
  mobile?: boolean;
}) {
  const { userId, sessionId } = useAuth();
  const identity = `${userId ?? "self-hosted"}\n${sessionId ?? ""}\n${scopeKey}\n${gatewayUrl}`;
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [groupExpanded, setGroupExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);

  // The gateway derives ownership from the authenticated request. A former
  // computer's response must never populate a newly selected account/runtime.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- projects belong to the current routed VPS and cannot be resolved at shell build time.
  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(gatewayUrl, controller.signal).then(projects => {
      if (!controller.signal.aborted) { setSnapshot({ identity, projects }); setFailedIdentity(null); }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] list unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setFailedIdentity(identity);
    });
    return () => controller.abort();
  }, [gatewayUrl, identity, retry]);

  const error = failedIdentity === identity;
  const projects = snapshot?.identity === identity && !error ? snapshot.projects : [];
  const loading = snapshot?.identity !== identity && !error;
  const expandedProjectIds = new Set(expandedProjects);
  return <nav aria-label="Projects" className="mx-2 space-y-1 text-sm">
    <ChatRailSection label="Projects" count={projects.length} countLabel={`${projects.length} hidden ${projects.length === 1 ? "project" : "projects"}`}
      expanded={groupExpanded} onExpandedChange={setGroupExpanded}>
      {loading ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading projects…</p> : null}
      {error ? <div className="px-2 py-2 text-xs text-muted-foreground">
        <p role="alert">Projects could not be loaded.</p>
        <button type="button" className={`mt-1 rounded px-2 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
          onClick={() => { setFailedIdentity(null); setRetry(value => value + 1); }}>Retry projects</button>
      </div> : null}
      {!loading && !error && projects.length === 0 ? <div className="space-y-1 px-2 py-3 text-xs text-muted-foreground">
        <Folder aria-hidden="true" size={16} strokeWidth={1.5} />
        <p className="font-medium text-foreground">No projects on this computer yet.</p>
        <p>Your project chats will appear here when a project is available.</p>
        <p>Create a project in Matrix Desktop to get started.</p>
      </div> : null}
      {projects.map(project => {
        const expanded = expandedProjectIds.has(project.id);
        return <div key={project.id}>
          <button type="button" aria-label={`Open ${project.name} project`} aria-expanded={expanded}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
            onClick={() => setExpandedProjects(current => expanded ? current.filter(id => id !== project.id) : [...current, project.id])}>
            <Folder aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" />
            <OverflowingChatTitle title={project.name} />
          </button>
          {expanded ? <WebProjectChats key={`${identity}/${project.id}`} gatewayUrl={gatewayUrl} projectId={project.id}
            activeChatId={activeChatId} onSelectChat={onSelectChat} mobile={mobile} /> : null}
        </div>;
      })}
    </ChatRailSection>
  </nav>;
}
