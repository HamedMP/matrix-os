import { useEffect, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { collaborationRuntimeIdFromSystemInfo } from "../../lib/collaboration";

export function useCollaborationRuntimeId(api: ApiClient | null): string | null {
  const [identity, setIdentity] = useState<{ api: ApiClient | null; runtimeId: string | null }>({
    api: null,
    runtimeId: null,
  });

  useEffect(() => {
    let active = true;
    if (!api || typeof api.get !== "function") return () => { active = false; };
    let request: Promise<unknown>;
    try {
      request = api.get<unknown>("/api/system/info", { maxBytes: 64 * 1024 });
    } catch (error: unknown) {
      console.warn("[collaboration] runtime capability unavailable", error instanceof Error ? error.name : "UnknownError");
      return () => { active = false; };
    }
    if (!request || typeof request.then !== "function") return () => { active = false; };
    void request.then((value) => {
      if (active) setIdentity({ api, runtimeId: collaborationRuntimeIdFromSystemInfo(value) });
    }).catch((error: unknown) => {
      console.warn("[collaboration] runtime capability unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api]);

  return api && typeof api.get === "function" && identity.api === api ? identity.runtimeId : null;
}
