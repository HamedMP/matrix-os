"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatSharingButton } from "@matrix-os/ui";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";

export function ChatSharing({ chatId }: { chatId: string }) {
  const platformHost = useBrowserOrigin();
  if (!platformHost) return null;
  return <BrowserChatSharing chatId={chatId} platformHost={platformHost} />;
}

function BrowserChatSharing({ chatId, platformHost }: { chatId: string; platformHost: string }) {
  const [runtime, setRuntime] = useState<{ handle: string | null; runtimeSlot: string; runtimeId: string | null }>({
    handle: null, runtimeSlot: "primary", runtimeId: null,
  });
  const gatewayUrl = getGatewayUrl();
  const api = useMemo(() => createChatSharingApi(gatewayUrl), [gatewayUrl]);
  const collaborationApi = useMemo(() => createShellCollaborationApi(platformHost), [platformHost]);
  useEffect(() => {
    let active = true;
    void api.get("/api/system/info").then((value) => {
      if (active) setRuntime(collaborationRuntimeFromSystemInfo(value));
    }).catch((failure: unknown) => {
      console.warn("[chat-collaboration] runtime identity unavailable", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api]);
  return <ChatSharingButton api={api} collaborationApi={collaborationApi} runtimeId={runtime.runtimeId}
    chatId={chatId} handle={runtime.handle} runtimeSlot={runtime.runtimeSlot}
    platformHost={platformHost} copyText={(text) => navigator.clipboard.writeText(text)} />;
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
