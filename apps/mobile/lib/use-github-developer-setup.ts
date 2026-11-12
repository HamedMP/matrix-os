import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import type { GatewayClient } from "@/lib/gateway-client";

type Client = Pick<GatewayClient, "startGithubDeveloperSetup" | "getGithubDeveloperSetup" | "cancelGithubDeveloperSetup">;
type View = { phase: "waiting"; code: string } | { phase: "starting" | "finishing" | "failed" | "expired" | "cancelled" };
type Attempt = { controller: AbortController; reconciled: boolean };
type Scope = { active: boolean; attempt: Attempt | null };

export function useGithubDeveloperSetup(client: Client | null, refresh: () => Promise<boolean>) {
  const scopeRef = useRef<Scope | null>(null);
  const [display, setDisplay] = useState<{ scope: Scope; client: Client; view: View } | null>(null);
  const [pending, setPending] = useState(false);

  useFocusEffect(useCallback(() => {
    const scope: Scope = { active: true, attempt: null };
    scopeRef.current = scope;
    setDisplay(null);
    setPending(false);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !scope.active) return;
      const attempt = scope.attempt;
      void refresh().then((ready) => {
        if (!ready || !scope.active || scopeRef.current !== scope || scope.attempt !== attempt) return;
        if (attempt) {
          attempt.reconciled = true;
          attempt.controller.abort();
        }
        setDisplay(null);
      }).catch((error: unknown) => {
        console.warn("[mobile] GitHub foreground refresh failed", error instanceof Error ? error.name : "unknown");
      });
    });
    return () => {
      scope.active = false;
      scope.attempt?.controller.abort();
      setDisplay(null);
      subscription.remove();
    };
  }, [client, refresh]));

  function dismiss() {
    scopeRef.current?.attempt?.controller.abort();
    setDisplay(null);
  }

  async function start() {
    const scope = scopeRef.current;
    if (!client || !scope?.active || scope.attempt) return;
    const controller = new AbortController();
    const attempt: Attempt = { controller, reconciled: false };
    scope.attempt = attempt;
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, 10 * 60_000);
    const current = () => scope.active && scopeRef.current === scope;
    const show = (view: View) => { if (current()) setDisplay({ scope, client, view }); };
    let id: string | undefined;
    let terminal = false;
    setPending(true);
    show({ phase: "starting" });
    try {
      // Keep this bounded start alive after dismissal to cancel a late-created ID
      // against the original computer, never a newly selected client.
      let operation = await client.startGithubDeveloperSetup();
      id = operation.id;
      let hadCode = false;
      let failures = 0;
      while (!controller.signal.aborted && current()) {
        if (operation.state === "succeeded") {
          terminal = true;
          setDisplay(null);
          await refresh();
          return;
        }
        if (operation.state === "failed" || operation.state === "expired" || operation.state === "cancelled") {
          terminal = true;
          show({ phase: operation.state });
          return;
        }
        if (operation.state === "awaiting_authorization") {
          hadCode = true;
          show({ phase: "waiting", code: operation.deviceCode });
        } else {
          show({ phase: hadCode ? "finishing" : "starting" });
        }
        await waitForPoll(controller.signal);
        try {
          const result = await client.getGithubDeveloperSetup(id, controller.signal);
          if (result.id !== id) throw new Error("Operation changed");
          operation = result;
          failures = 0;
        } catch (error: unknown) {
          if (controller.signal.aborted || ++failures > 2) throw error;
        }
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        console.warn("[mobile] GitHub setup failed", error instanceof Error ? error.name : "unknown");
        // Completed operations are evicted by the gateway after a short TTL.
        // Canonical readiness can prove success even when a poll is now 404.
        const ready = await refresh();
        if (ready && current() && !controller.signal.aborted) {
          terminal = true;
          setDisplay(null);
        } else if (!controller.signal.aborted) {
          show({ phase: "failed" });
        }
      }
    } finally {
      clearTimeout(timer);
      if (expired && !attempt.reconciled) show({ phase: "expired" });
      if (id && !terminal && !attempt.reconciled) {
        try { await client.cancelGithubDeveloperSetup(id); }
        catch (error: unknown) {
          console.warn("[mobile] GitHub setup cancellation failed", error instanceof Error ? error.name : "unknown");
        }
      }
      scope.attempt = null;
      if (current()) setPending(false);
    }
  }

  const view = display?.client === client && display?.scope === scopeRef.current && display?.scope.active ? display.view : null;
  return { view, pending, start, dismiss };
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
