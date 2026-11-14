/**
 * Connects an open owner app with the Publish app popover in its window chrome. The two
 * render in different trees, so the viewer reports rebuilds (sharing re-reads readiness)
 * and the popover reports confirmed share changes (the viewer refreshes its app context).
 * Events are scoped to one app slug inside this shell's own runtime.
 */
export type OwnerAppSharingEventKind = "build-changed" | "share-changed";

const OWNER_APP_SHARING_EVENT = "matrix:owner-app-sharing";

interface OwnerAppSharingDetail {
  appId: string;
  kind: OwnerAppSharingEventKind;
}

function isDetail(value: unknown): value is OwnerAppSharingDetail {
  if (typeof value !== "object" || value === null) return false;
  const detail = value as Record<string, unknown>;
  return typeof detail.appId === "string" && (detail.kind === "build-changed" || detail.kind === "share-changed");
}

export function notifyOwnerAppSharing(appId: string, kind: OwnerAppSharingEventKind): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OwnerAppSharingDetail>(OWNER_APP_SHARING_EVENT, { detail: { appId, kind } }));
}

export function subscribeOwnerAppSharing(
  appId: string,
  kind: OwnerAppSharingEventKind,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isDetail(detail) && detail.appId === appId && detail.kind === kind) listener();
  };
  window.addEventListener(OWNER_APP_SHARING_EVENT, handle);
  return () => window.removeEventListener(OWNER_APP_SHARING_EVENT, handle);
}
