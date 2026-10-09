"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatSharingButton } from "@matrix-os/ui";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo } from "@/lib/collaboration";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";

export function ChatSharing({ chatId }: { chatId: string }) {
  const platformHost = useBrowserOrigin();
  if (!platformHost) return null;
  return <BrowserChatSharing chatId={chatId} platformHost={platformHost} />;
}

function BrowserChatSharing({ chatId, platformHost }: { chatId: string; platformHost: string }) {
  const { status: organizationStatus, organizationId } = useCollaborationOrganization();
  const verifiedOrganizationId = organizationStatus === "member" ? organizationId : null;
  const [runtime, setRuntime] = useState<{ handle: string | null; runtimeSlot: string; runtimeId: string | null }>({
    handle: null, runtimeSlot: "primary", runtimeId: null,
  });
  const gatewayUrl = getGatewayUrl();
  const api = useMemo(() => createChatSharingApi(gatewayUrl), [gatewayUrl]);
  const collaborationApi = useShellCollaborationApi(platformHost, organizationStatus !== "none") ?? undefined;
  useEffect(() => {
    let active = true;
    void api.get("/api/system/info").then((value) => {
      const { handle, runtimeSlot, runtimeId } = collaborationRuntimeFromSystemInfo(value);
      if (active) setRuntime({ handle, runtimeSlot, runtimeId });
    }).catch((failure: unknown) => {
      console.warn("[chat-share] runtime identity unavailable", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api]);
  return <ChatSharingButton key={verifiedOrganizationId ?? organizationStatus} api={api}
    chatId={chatId} handle={runtime.handle} runtimeSlot={runtime.runtimeSlot}
    platformHost={platformHost} copyText={(text) => navigator.clipboard.writeText(text)}
    legacyCollaboration={collaborationApi ? {
      api: collaborationApi,
      runtimeId: runtime.runtimeId,
      organizationId: verifiedOrganizationId,
    } : undefined} />;
}

function createChatSharingApi(baseUrl: string) {
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("ChatSharingUnavailable");
    return response.json();
  };
  return { baseUrl,
    get: async (path: string) => request(path),
    post: (path: string, body: unknown) => request(path, "POST", body),
    delete: (path: string) => request(path, "DELETE"),
  };
}
