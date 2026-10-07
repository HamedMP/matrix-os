import { useEffect, useState } from "react";
import { CollaborationDiscoveryResponseSchema } from "@matrix-os/contracts";
import { subscribeCollaborationDiscoveryChanged } from "@matrix-os/ui";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export type WorkSharedItem = ReturnType<typeof CollaborationDiscoveryResponseSchema.parse>["items"][number];
export function sharedItemLabel(item: WorkSharedItem): string {
  if (item.status === "accepted" && item.resource && "chat" in item.resource) return item.resource.chat.title;
  if (item.status === "invited") return item.resource ? `${item.resource.owner.displayName} invited you` : `Shared ${item.kind} invitation`;
  return `Shared ${item.kind}`;
}
export function sharedItemContext(item: WorkSharedItem): string {
  return `${item.status === "invited" ? "Invitation" : "Shared"} · Shared ${item.kind}`;
}
export function useWorkSharedDiscovery(active: boolean) {
  const actorId = useConnection(state => state.userId);
  const platformHost = useConnection(state => state.platformHost);
  const authGeneration = useConnection(state => state.authGeneration);
  const organizationStatus = useConnection(state => state.organizationStatus);
  const enabled = active && organizationStatus !== "none";
  const key = `${actorId ?? ""}\0${platformHost}\0${authGeneration}`;
  const [snapshot, setSnapshot] = useState<{ key: string; items: WorkSharedItem[]; loading: boolean; error: string | null } | null>(null);
  useEffect(() => {
    if (!actorId || !platformHost || organizationStatus === "none") {
      // Membership loss invalidates organization-owned discovery. Keeping the
      // snapshot would briefly restore stale shares if the same account rejoins.
      setSnapshot(current => current === null ? current : null);
      return;
    }
    // Closing search pauses discovery without discarding already loaded results.
    if (!active) return;
    const api = createDesktopCollaborationApi(platformHost);
    if (!api) { setSnapshot({ key, items: [], loading: false, error: "Shared items could not be loaded. Try again." }); return; }
    let current = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const pages = await Promise.all([api.get("/api/collaboration/inbox"), api.get("/api/collaboration/shared")]);
        const seen = new Set<string>();
        const items = pages.flatMap(page => CollaborationDiscoveryResponseSchema.parse(page).items).filter(item => {
          const id = item.status === "invited" ? `invite:${item.invitationId}` : `scope:${item.scopeId}`;
          if (seen.has(id)) return false;
          seen.add(id); return true;
        }).slice(0, 100);
        if (current) setSnapshot({ key, items, loading: false, error: null });
      } catch (error: unknown) {
        console.warn("[work-search] Shared discovery unavailable:", error instanceof Error ? error.name : "UnknownError");
        if (current) setSnapshot({ key, items: [], loading: false, error: "Shared items could not be loaded. Try again." });
      } finally { pending = false; }
    };
    void refresh();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(() => { void refresh(); });
    return () => { current = false; unsubscribe(); releaseDesktopCollaborationApi(api); };
  }, [active, actorId, platformHost, authGeneration, key, organizationStatus]);
  const available = Boolean(actorId && platformHost && organizationStatus !== "none");
  return snapshot?.key === key && enabled
    ? { ...snapshot, available }
    : { items: [] as WorkSharedItem[], loading: enabled && available, error: null, available };
}
