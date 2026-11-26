/**
 * Spec 2707: Settings and the Web Desktop computer menu are separate trees.
 * A successful owned-computer change announces itself on the window so the
 * menu reloads instead of offering a renamed or removed computer.
 */
export const COMPUTERS_CHANGED_EVENT = "matrix:computers-changed";

export function announceComputersChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COMPUTERS_CHANGED_EVENT));
}

export function subscribeComputersChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(COMPUTERS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(COMPUTERS_CHANGED_EVENT, listener);
}
