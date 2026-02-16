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
    fetch(`${url}/api/identity`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.handle) setIdentity(data);
      })
      .catch(() => {});
  }, []);

  return identity;
}
