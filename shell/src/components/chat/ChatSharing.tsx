"use client";

import { useMemo, useState } from "react";
import { z } from "zod/v4";
import { ChatSharingButton } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";

const RuntimeSchema = z.object({ runtime: z.object({ handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).nullable(), runtimeSlot: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }) });

export function ChatSharing({ chatId }: { chatId: string }) {
  const [runtime, setRuntime] = useState<{ handle: string | null; runtimeSlot: string }>({ handle: null, runtimeSlot: "primary" });
  const api = useMemo(() => {
    const baseUrl = getGatewayUrl();
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("ChatSharingUnavailable");
      return response.json();
    };
    return { baseUrl,
      get: async (path: string) => {
        if (path.endsWith("/preview")) {
          const [preview, info] = await Promise.all([request(path), request("/api/system/info")]);
          setRuntime(RuntimeSchema.parse(info).runtime);
          return preview;
        }
        return request(path);
      },
      post: (path: string, body: unknown) => request(path, "POST", body),
      delete: (path: string) => request(path, "DELETE"),
    };
  }, []);
  return <ChatSharingButton api={api} chatId={chatId} handle={runtime.handle} runtimeSlot={runtime.runtimeSlot}
    platformHost={typeof window === "undefined" ? "" : window.location.origin} copyText={(text) => navigator.clipboard.writeText(text)} />;
}
