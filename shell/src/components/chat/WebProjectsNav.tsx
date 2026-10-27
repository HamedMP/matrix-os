"use client";

import { ChatRailSection, OverflowingChatTitle } from "@matrix-os/ui";
import { useAuth } from "@clerk/nextjs";
import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import type { RenameableConversation } from "./ChatTitleRename";

const ProjectsResponseSchema = z.object({
  projects: z.array(z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  })),
});
type Project = z.infer<typeof ProjectsResponseSchema>["projects"][number];
type ProjectSnapshot = { identity: string; projects: Project[] };

export function WebProjectsNav({ gatewayUrl, scopeKey, chats, activeChatId, onSelectChat, mobile = false }: {
  gatewayUrl: string;
  scopeKey: string;
  chats: readonly RenameableConversation[];
  activeChatId?: string;
  onSelectChat(chatId: string): void;
  mobile?: boolean;
}) {
  const { userId, sessionId } = useAuth();
  const identity = `${userId ?? "self-hosted"}\n${sessionId ?? ""}\n${scopeKey}\n${gatewayUrl}`;
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [groupExpanded, setGroupExpanded] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);

  // The gateway derives ownership from the authenticated request. A former
  // computer's response must never populate a newly selected account/runtime.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- projects belong to the current routed VPS and cannot be resolved at shell build time.
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    const load = async () => {
      try {
        const response = await fetch(`${gatewayUrl}/api/workspace/projects`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) throw new Error("ProjectsUnavailable");
        const result = ProjectsResponseSchema.parse(await response.json());
        if (!controller.signal.aborted) { setSnapshot({ identity, projects: result.projects }); setError(false); }
      } catch (cause: unknown) {
        if (controller.signal.aborted) return;
        console.warn("[web-projects] list unavailable", cause instanceof Error ? cause.name : "UnknownError");
        setError(true);
      }
    };
    void load();
    return () => controller.abort();
  }, [gatewayUrl, identity, retry]);

  const projects = snapshot?.identity === identity && !error ? snapshot.projects : [];
  const loading = snapshot?.identity !== identity && !error;
  return <nav aria-label="Projects" className="mx-2 space-y-1 text-sm">
    <ChatRailSection label="Projects" count={projects.length} countLabel={`${projects.length} hidden ${projects.length === 1 ? "project" : "projects"}`}
      expanded={groupExpanded} onExpandedChange={setGroupExpanded}>
      {loading ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading projects…</p> : null}
      {error ? <div className="px-2 py-2 text-xs text-muted-foreground">
        <p role="alert">Projects could not be loaded.</p>
        <button type="button" className={`mt-1 rounded px-2 text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
          onClick={() => setRetry(value => value + 1)}>Retry projects</button>
      </div> : null}
      {!loading && !error && projects.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">No projects on this computer yet.</p> : null}
      {projects.map(project => {
        const projectChats = chats.filter(chat => chat.canonicalRecord?.projectId === project.id);
        const expanded = expandedProjects.includes(project.id);
        return <div key={project.id}>
          <button type="button" aria-label={`Open ${project.name} project`} aria-expanded={expanded}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
            onClick={() => setExpandedProjects(current => expanded ? current.filter(id => id !== project.id) : [...current, project.id])}>
            <Folder aria-hidden="true" size={15} strokeWidth={1.5} className="shrink-0" />
            <OverflowingChatTitle title={project.name} />
            {projectChats.length > 0 ? <span className="ml-auto text-xs text-muted-foreground">{projectChats.length}</span> : null}
          </button>
          {expanded ? <div className="ml-4 border-l border-border pl-2">
            {projectChats.length > 0 ? projectChats.map(chat => <button key={chat.id} type="button"
              aria-current={activeChatId === chat.id ? "page" : undefined}
              className={`w-full truncate rounded px-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary ${mobile ? "min-h-11" : "min-h-9"}`}
              onClick={() => onSelectChat(chat.id)}>{chat.title ?? chat.preview}</button>)
              : <p className="px-2 py-2 text-xs text-muted-foreground">No chats to show here.</p>}
          </div> : null}
        </div>;
      })}
    </ChatRailSection>
  </nav>;
}
