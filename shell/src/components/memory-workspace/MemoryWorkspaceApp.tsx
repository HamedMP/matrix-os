"use client";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  MemoryWorkspace,
  createMemoryWorkspaceClient,
  type MemoryTransport,
} from "@matrix-os/ui";
import type {
  MemoryContextResult,
  CanonicalChatResourceReference,
} from "@matrix-os/contracts";
import "@matrix-os/ui/memory-workspace.css";
import { createShellApiClient } from "@/api/http";
import { getGatewayUrl } from "@/lib/gateway";
import {
  isSelfHostedRuntime,
  SELF_HOSTED_SHELL_USER_ID,
} from "@/lib/self-host-mode";
import { useWindowManager } from "@/hooks/useWindowManager";
import {
  useCompanyDriveChatDraft,
  COMPANY_DRIVE_MOBILE_CHAT_EVENT,
} from "@/stores/company-drive-chat-draft";
import { organizationDriveNavigationIdentity } from "@/stores/organization-drive-navigation";
export function MemoryWorkspaceApp({ mobile = false }: { mobile?: boolean }) {
  return isSelfHostedRuntime() ? (
    <Workspace userId={SELF_HOSTED_SHELL_USER_ID} mobile={mobile} />
  ) : (
    <AuthenticatedWorkspace mobile={mobile} />
  );
}
function AuthenticatedWorkspace({ mobile }: { mobile: boolean }) {
  const { userId, sessionId } = useAuth();
  return <Workspace userId={userId} sessionId={sessionId} mobile={mobile} />;
}
function Workspace({
  userId,
  sessionId,
  mobile,
}: {
  userId: string | null | undefined;
  sessionId?: string | null;
  mobile: boolean;
}) {
  const gateway = getGatewayUrl();
  const identity = organizationDriveNavigationIdentity(
    userId,
    sessionId,
    gateway,
  );
  const activeIdentity = useRef<string | null>(identity);
  useLayoutEffect(() => {
    activeIdentity.current = identity;
    return () => {
      activeIdentity.current = null;
    };
  }, [identity]);
  const api = useMemo(
    () => createShellApiClient({ getGatewayUrl: () => gateway }),
    [gateway],
  );
  const client = useMemo(
    () =>
      createMemoryWorkspaceClient({
        request: <T,>(
          method: Parameters<MemoryTransport["request"]>[0],
          path: string,
          body?: unknown,
        ) =>
          method === "GET"
            ? api.get<T>(path, { timeoutMs: 45_000 })
            : method === "DELETE"
              ? api.delete<T>(path)
              : method === "PATCH"
                ? api.patch<T>(path, body)
                : api.post<T>(path, body, { timeoutMs: 45_000 }),
      }),
    [api],
  );
  async function useInChat(sourceIds: string[]) {
    const context = await api.post<MemoryContextResult>(
      "/api/memory-workspace/context",
      { sourceIds },
    );
    if (activeIdentity.current !== identity) return;
    const references: CanonicalChatResourceReference[] = context.sources
      .slice(0, 8)
      .map((source) => ({
        kind: "memory_source",
        id: source.sourceId,
        label: source.title.slice(0, 280),
        revision: String(source.revision),
      }));
    if (!references.length) throw new Error("context_unavailable");
    useCompanyDriveChatDraft.getState().openMemory(references, identity);
    if (mobile)
      window.dispatchEvent(new CustomEvent(COMPANY_DRIVE_MOBILE_CHAT_EVENT));
    else useWindowManager.getState().openWindow("Chat", "__chat__", 0);
  }
  return (
    <MemoryWorkspace
      client={client}
      identity={identity}
      onUseInChat={useInChat}
      onOpenFiles={() =>
        useWindowManager.getState().openWindow("Files", "__file-browser__", 0)
      }
    />
  );
}
