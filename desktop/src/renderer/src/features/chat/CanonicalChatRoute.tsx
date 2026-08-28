import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { diagnosticErrorKind } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useProjectView } from "../../stores/project-view";
import { useTabs } from "../../stores/tabs";
import { CanonicalChatWorkspace } from "./CanonicalChatWorkspace";

type CanonicalRouteAvailability = "checking" | "available" | "unavailable";

export function CanonicalChatRoute({
  api,
  projectId,
  tabId,
  initialChatId,
  initialView,
  projectLabel,
  active,
  fallback,
  inspector,
}: {
  api: ApiClient | null;
  projectId: string | null;
  tabId?: string;
  initialChatId?: string;
  initialView?: "index" | "draft" | "conversation";
  projectLabel?: string;
  active: boolean;
  fallback: ReactNode;
  inspector?: ReactNode;
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
      delete<T>(path: string) {
        return currentApi().delete<T>(path);
      },
    });
  }, [clientIdentity]);
  const canonicalProjectId = useBoard((state) => {
    if (projectId === null) return null;
    return state.projects.find((project) => project.slug === projectId || project.id === projectId)?.id
      ?? projectId;
  });
  const routeKey = clientIdentity
    ? `${clientIdentity}\u0000${canonicalProjectId ?? "global"}`
    : null;
  const [availability, setAvailability] = useState<{
    routeKey: string | null;
    value: CanonicalRouteAvailability;
  }>(() => ({
    routeKey,
    value: routeKey ? "checking" : "unavailable",
  }));
  const currentAvailability: CanonicalRouteAvailability = availability.routeKey === routeKey
    ? availability.value
    : routeKey ? "checking" : "unavailable";
  const provenRoute = useRef<{
    client: ReturnType<typeof createCanonicalChatClient>;
    projectId: string | null;
  } | null>(null);

  useEffect(() => {
    let current = true;
    if (!client) {
      provenRoute.current = null;
      setAvailability({ routeKey: null, value: "unavailable" });
      return () => { current = false; };
    }
    if (!active) return () => { current = false; };
    if (
      provenRoute.current?.client === client
      && provenRoute.current.projectId === canonicalProjectId
    ) {
      setAvailability({ routeKey, value: "available" });
      return () => { current = false; };
    }
    setAvailability({ routeKey, value: "checking" });
    void client.list({ projectId: canonicalProjectId, limit: 1 }).then(() => {
      if (!current) return;
      provenRoute.current = { client, projectId: canonicalProjectId };
      setAvailability({ routeKey, value: "available" });
    }).catch((error: unknown) => {
      console.warn("[canonical-chat] route probe failed:", diagnosticErrorKind(error));
      if (!current) return;
      provenRoute.current = null;
      setAvailability({ routeKey, value: "unavailable" });
    });
    return () => { current = false; };
  }, [active, canonicalProjectId, client, routeKey]);

  if (!client || currentAvailability === "unavailable") return fallback;
  if (currentAvailability === "checking") {
    return (
      <div
        role="status"
        aria-label="Loading chats"
        className="flex min-h-0 flex-1 items-center justify-center text-sm"
        style={{ color: "var(--text-tertiary)" }}
      >
        Loading chats…
      </div>
    );
  }
  return (
    <CanonicalChatWorkspace
      api={api ?? undefined}
      client={client}
      projectId={canonicalProjectId}
      initialChatId={initialChatId}
      initialView={initialView}
      projectLabel={projectLabel}
      active={active}
      inspector={inspector}
      onActiveChatChanged={(chatId, title) => {
        if (chatId) {
          useTabs.getState().recordRecentCanonicalChat(
            chatId,
            title ?? "Chat",
            canonicalProjectId,
          );
        }
        if (projectId === null) {
          if (tabId) {
            useTabs.getState().updateChatRoute(tabId, {
              title: title ?? "Chat",
              chatView: chatId ? "conversation" : "draft",
              ...(chatId ? { chatId } : {}),
            });
            return;
          }
          useTabs.getState().openTab({
            kind: "chat",
            title: title ?? "Chat",
            chatView: chatId ? "conversation" : "draft",
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
      onProjectChanged={(chatId, targetProjectId, title) => {
        useTabs.getState().recordRecentCanonicalChat(chatId, title, targetProjectId);
        if (targetProjectId === null) {
          if (tabId) {
            useTabs.getState().updateChatRoute(tabId, {
              title,
              chatId,
              chatView: "conversation",
            });
            return;
          }
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
      onChatDeleted={(chatId) => useTabs.getState().removeRecentView("conversation", chatId)}
    />
  );
}
