"use client";

import { CollaborationDiscoveryResponseSchema } from "@matrix-os/contracts";
import { subscribeCollaborationDiscoveryChanged } from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { MessageSquareIcon } from "@/lib/hugeicons";

export function SharedWithMeNav({ active, onOpen }: { active: boolean; onOpen(): void }) {
  const origin = useBrowserOrigin();
  const api = useMemo(() => origin ? createShellCollaborationApi(origin) : null, [origin]);
  const [pending, setPending] = useState<number | null>(null);
  const loadPendingCount = useCallback(async () => {
    if (!api) return null;
    const page = CollaborationDiscoveryResponseSchema.parse(await api.get("/api/collaboration/inbox?limit=100"));
    return page.items.filter((item) => item.status === "invited").length;
  }, [api]);
  useEffect(() => {
    if (!api) return;
    let current = true;
    const load = () => void loadPendingCount().then((count) => {
      if (current && count !== null) setPending(count);
    }).catch((failure: unknown) => {
        console.warn("[collaboration-discovery] navigation unavailable", failure instanceof Error ? failure.name : "UnknownError");
        if (current) setPending(null);
      });
    load();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(load);
    return () => { current = false; unsubscribe(); };
  }, [api, loadPendingCount]);
  if (pending === null) return null;
  return <button type="button" aria-current={active ? "page" : undefined} onClick={onOpen}
    className="mx-2 mb-1 flex min-h-10 w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2.5 text-left text-xs hover:bg-accent aria-[current=page]:bg-accent">
    <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate">Shared with me</span>
    {pending > 0 ? <span aria-label={`${pending} pending invitation${pending === 1 ? "" : "s"}`}
      className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold text-primary-foreground">
      {pending > 99 ? "99+" : pending}
    </span> : null}
  </button>;
}
