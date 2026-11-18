"use client";

import { isPrivatePreviewHandle } from "@matrix-os/contracts";
import { BotsWorkspace, type HostedBotsTransport } from "@matrix-os/ui";
import { createContext, useContext } from "react";

interface WebHostedBotsTransport extends HostedBotsTransport {
  scope: string;
}

const webBotsTransport = createContext<WebHostedBotsTransport | null>(null);
export const WebHostedBotsProvider = webBotsTransport.Provider;

export function createWebHostedBotsTransport(
  gateway: string,
  accountScope: string | undefined,
  runtimeScope: string | undefined,
): WebHostedBotsTransport | null {
  if (!accountScope || !runtimeScope?.startsWith("/vm/") || !isPrivatePreviewHandle(runtimeScope.slice(4))) return null;
  const targetPath = new URL(gateway).pathname;
  if (targetPath !== runtimeScope && !targetPath.startsWith(runtimeScope + "/~runtime/")) return null;
  async function request(path: string, method: "GET" | "POST" | "PUT", data?: unknown): Promise<unknown> {
    const response = await fetch(gateway + path, {
      method,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
    });
    if (!response.ok) throw new Error("Bots is unavailable");
    return response.json() as Promise<unknown>;
  }
  return {
    scope: JSON.stringify([gateway, accountScope ?? null]),
    get: (path) => request(path, "GET"),
    post: (path, data) => request(path, "POST", data),
    put: (path, data) => request(path, "PUT", data),
  };
}

export function WebBotsWorkspace({ active }: { active: boolean }) {
  const transport = useContext(webBotsTransport);
  return <BotsWorkspace key={transport?.scope} transport={transport} active={active} />;
}
