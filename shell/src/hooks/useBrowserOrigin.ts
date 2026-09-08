"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;
const getServerSnapshot = () => null;
const getSnapshot = () => window.location.origin;

/** Keep the server render and hydration render identical before exposing browser state. */
export function useBrowserOrigin(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
