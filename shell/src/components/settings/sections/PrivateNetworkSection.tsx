"use client";
import { useMemo } from "react";
import { createPrivateNetworkClient, PrivateNetworkPanel, type PrivateNetworkTransport } from "@matrix-os/ui/private-network";
import { getGatewayUrl } from "@/lib/gateway";

const REQUEST_TIMEOUT_MS = 15_000;

class PrivateNetworkRequestError extends Error {
  constructor(readonly status: number) {
    super("Private network request failed");
    this.name = "PrivateNetworkRequestError";
  }
}

function createShellTransport(base: string): PrivateNetworkTransport {
  async function send<T>(method: "GET" | "POST" | "DELETE", path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new PrivateNetworkRequestError(response.status);
    return (await response.json()) as T;
  }
  return {
    get: (path, signal) => send("GET", path, undefined, signal),
    post: (path, body, signal) => send("POST", path, body, signal),
    delete: (path, body, signal) => send("DELETE", path, body, signal),
  };
}

/** Web Desktop and Web Canvas Settings -> System private network panel. */
export function PrivateNetworkSection() {
  const base = getGatewayUrl();
  const client = useMemo(() => createPrivateNetworkClient(createShellTransport(base)), [base]);
  return <PrivateNetworkPanel key={base} client={client} />;
}
