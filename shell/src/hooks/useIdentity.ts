"use client";

import { useState, useEffect } from "react";
import { getGatewayUrl } from "@/lib/gateway";

export interface UserIdentity {
  handle: string;
  aiHandle: string;
  displayName: string;
  createdAt: string;
}

export function useIdentity() {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);

  useEffect(() => {
    const url = getGatewayUrl();
    fetch(`${url}/api/identity`, { signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.handle) setIdentity(data);
      })
      .catch((err: unknown) => {
        console.warn("[identity] Failed to fetch identity:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  return identity;
}
