export const COLLABORATION_DISCOVERY_CHANGED_EVENT = "matrix:collaboration-discovery-changed";

/** Notify navigation badges to refetch from the authoritative collaboration inbox. */
export function notifyCollaborationDiscoveryChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COLLABORATION_DISCOVERY_CHANGED_EVENT));
}

export function subscribeCollaborationDiscoveryChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(COLLABORATION_DISCOVERY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(COLLABORATION_DISCOVERY_CHANGED_EVENT, listener);
}
