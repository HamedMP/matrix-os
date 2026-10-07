import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { ChatAgentClient } from "../client.js";
import { botSummaryReads } from "./bot-summary-reads.js";

const REFRESH_MS = 5_000;
const emptySnapshot = () => undefined;
const noSubscription = () => () => undefined;

/** Verified same-client definitions survive remount/revalidation. Authoritative
 * empty/disabled responses replace them; transport failures never invent emptiness. */
export function useAgentRailLibrary(client: ChatAgentClient | undefined, active: boolean, navigation: unknown) {
  const reads = client ? botSummaryReads(client) : undefined;
  // Hidden retained rails still receive authoritative definition changes. The
  // subscription itself performs no reads; visibility gates revalidation below.
  const library = useSyncExternalStore(reads?.subscribeLibrary ?? noSubscription,
    reads?.librarySnapshot ?? emptySnapshot, emptySnapshot);
  const instance = useId();
  const activation = useRef(0);
  useEffect(() => {
    if (!reads || !active) return;
    let current = true;
    let pending = false;
    const refresh = (token: string, replacePending = false) => {
      if (pending || !current || document.visibilityState !== "visible") return;
      pending = true;
      void reads.library(token, replacePending).catch((error: unknown) => {
        console.warn("[chat-agents] Rail unavailable:", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => { pending = false; });
    };
    refresh(`rail-library:${instance}:${++activation.current}`, true);
    const focus = (event: FocusEvent) => { refresh(`focus:${event.timeStamp}`); };
    const timer = window.setInterval(() => { refresh(`rail-library-poll:${Math.floor(Date.now() / REFRESH_MS)}`); }, REFRESH_MS);
    window.addEventListener("focus", focus);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [reads, active, navigation, instance]);
  return library;
}
