import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { useBoard } from "../../stores/board";
import { useProjectView } from "../../stores/project-view";
import { useTabs } from "../../stores/tabs";
import { CanonicalChatWorkspace } from "./CanonicalChatWorkspace";

export function CanonicalChatRoute({
  api,
  projectId,
  initialChatId,
  projectLabel,
  active,
  fallback,
}: {
  api: ApiClient | null;
  projectId: string | null;
  initialChatId?: string;
  projectLabel?: string;
  active: boolean;
  fallback: ReactNode;
}) {
  const client = useMemo(() => (
    api?.baseUrl ? createCanonicalChatClient(api) : null
  ), [api]);
  const canonicalProjectId = useBoard((state) => {
    if (projectId === null) return null;
    return state.projects.find((project) => project.slug === projectId || project.id === projectId)?.id
      ?? projectId;
  });
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let current = true;
    if (!client) {
      setAvailable(false);
      return () => { current = false; };
    }
    if (!active) return () => { current = false; };
    setAvailable(false);
    void client.list({ projectId: canonicalProjectId, limit: 1 }).then(() => {
      if (current) setAvailable(true);
    }).catch(() => {
      if (current) setAvailable(false);
    });
    return () => { current = false; };
  }, [active, canonicalProjectId, client]);

  if (!client || !available) return fallback;
  return (
    <CanonicalChatWorkspace
      api={api ?? undefined}
      client={client}
      projectId={canonicalProjectId}
      initialChatId={initialChatId}
      projectLabel={projectLabel}
      active={active}
      onProjectChanged={(chatId, targetProjectId) => {
        if (targetProjectId === null) {
          useTabs.getState().openTab({ kind: "chat", title: "Chat", chatId, closable: false });
          return;
        }
        const project = useBoard.getState().projects.find((candidate) => (
          candidate.id === targetProjectId || candidate.slug === targetProjectId
        ));
        const projectSlug = project?.slug ?? targetProjectId;
        useProjectView.getState().setView(projectSlug, "chats");
        useTabs.getState().openTab({
          kind: "project",
          projectSlug,
          chatId,
          title: project?.name ?? projectSlug,
        });
      }}
    />
  );
}
