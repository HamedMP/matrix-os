import { useSyncExternalStore } from "react";

// Client-only mount gate without a setState-in-effect cascade or hydration flicker.
// useSyncExternalStore returns false during SSR/hydration (matching the server snapshot)
// and true on the client afterwards, so consumers can render a stable SSR placeholder and
// switch to client-only content in a single, flicker-free transition.
const subscribeNoop = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);
}
