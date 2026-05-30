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
    // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- intentional one-shot mount load of the current user's identity from the gateway; bounded by AbortSignal.timeout(10s) and only sets state when a handle is present, so a data-fetching library would add no safety to this single static read
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
