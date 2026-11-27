/**
 * Bounded listener registration for the Docs app's stores (session, editor,
 * review, assistant). A subscriber that never unsubscribes (a leak) hits the
 * cap and gets an error instead of growing the registry forever; the returned
 * function removes the listener, and a store's dispose clears its registry.
 */

/** The most listeners one registry holds. The app itself uses a handful per store. */
export const MAX_LISTENERS = 64;

/** Adds a listener to a registry and returns the function that removes it. Throws at the cap. */
export function addListener<L>(registry: Set<L>, listener: L, name: string): () => void {
  if (registry.size >= MAX_LISTENERS) throw new Error(`too many ${name} listeners`);
  registry.add(listener);
  return () => {
    registry.delete(listener);
  };
}
