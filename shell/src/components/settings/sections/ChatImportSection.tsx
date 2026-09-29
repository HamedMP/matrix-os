"use client";

import { ChatImportPanel } from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";

export function ChatImportSection() {
  const gatewayUrl = getGatewayUrl();
  return <div className="p-6">
    <ChatImportPanel request={async (path, body) => {
      const response = await fetch(`${gatewayUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        headers: { "X-Matrix-Chat-Metadata": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(path.endsWith("/complete") ? 5 * 60_000 : 30_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Matrix Chat import request failed.");
      return response.json() as Promise<unknown>;
    }} />
  </div>;
}
