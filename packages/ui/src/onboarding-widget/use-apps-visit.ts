import { useState } from "react";
import { connectedAppIds } from "./helpers.js";
import type { OnboardingWidgetApp } from "./types.js";

export interface AppsVisit {
  appQuery: string;
  onAppQuery(query: string): void;
  /** Apps already connected when the list opened, so Done names only new connections. */
  appsConnectedBefore: readonly string[];
}

/** Search text and the starting connections for the app list; kept while the widget is minimized. */
export function useAppsVisit(open: boolean, apps: readonly OnboardingWidgetApp[]): AppsVisit {
  const [appQuery, setAppQuery] = useState("");
  const [connectedBefore, setConnectedBefore] = useState<readonly string[] | null>(null);
  if (open && connectedBefore === null) setConnectedBefore(connectedAppIds(apps));
  if (!open && connectedBefore !== null) setConnectedBefore(null);
  return { appQuery, onAppQuery: setAppQuery, appsConnectedBefore: connectedBefore ?? [] };
}
