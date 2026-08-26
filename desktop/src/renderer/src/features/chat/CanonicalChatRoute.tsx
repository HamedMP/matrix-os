import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
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
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const latestApi = useRef(api);
  latestApi.current = api;
  const clientIdentity = api?.baseUrl
    ? `${api.baseUrl}\u0000${runtimeSlot}\u0000${authGeneration}`
    : null;
  const client = useMemo(() => {
    if (!clientIdentity) return null;
    const currentApi = () => {
      if (!latestApi.current) throw new Error("ChatApiUnavailable");
      return latestApi.current;
    };
    return createCanonicalChatClient({
      get<T>(path: string) {
        return currentApi().get<T>(path);
      },
      post<T>(path: string, body: unknown) {
        return currentApi().post<T>(path, body);
      },
      patch<T>(path: string, body: unknown) {
        return currentApi().patch<T>(path, body);
      },
    });
  }, [clientIdentity]);
  const canonicalProjectId = useBoard((state) => {
    if (projectId === null) return null;
    return state.projects.find((project) => project.slug === projectId || project.id === projectId)?.id
      ?? projectId;
  });
  const [available, setAvailable] = useState(false);
  const provenRoute = useRef<{
    client: ReturnType<typeof createCanonicalChatClient>;
    projectId: string | null;
  } | null>(null);

  useEffect(() => {
    let current = true;
    if (!client) {
      provenRoute.current = null;
      setAvailable(false);
      return () => { current = false; };
    }
    if (!active) return () => { current = false; };
    if (
      provenRoute.current?.client === client
      && provenRoute.current.projectId === canonicalProjectId
    ) return () => { current = false; };
    setAvailable(false);
    void client.list({ projectId: canonicalProjectId, limit: 1 }).then(() => {
      if (!current) return;
      provenRoute.current = { client, projectId: canonicalProjectId };
      setAvailable(true);
    }).catch(() => {
      if (!current) return;
      provenRoute.current = null;
      setAvailable(false);
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
      onActiveChatChanged={(chatId, title) => {
        if (projectId === null) {
          useTabs.getState().openTab({
            kind: "chat",
            title: title ?? "Chat",
            ...(chatId ? { chatId } : {}),
            closable: false,
          });
          return;
        }
        useTabs.getState().openTab({
          kind: "project",
          projectSlug: projectId,
          title: projectLabel ?? projectId,
          ...(chatId ? { chatId } : {}),
        });
      }}
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
