import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { useGateway } from "@/app/_layout";
import { CODING_AGENTS_MOBILE_WORKSPACE } from "@/lib/feature-flags";
import { INITIAL_STATE, type ScreenState } from "@/components/agents/agent-workspace-shared";

// Shared runtime-summary lifecycle for the agent workspace surfaces that only
// need the plain summary (cockpit, providers, terminals). The reviews screen
// keeps its own bespoke loader because it chains review + snapshot reconciliation
// into the same generation guard.
//
// `refreshCompanion` must be a stable callback (or undefined); it runs alongside
// the summary load on mount and manual pull-to-refresh, but not on focus/AppState
// wake-ups.
export function useRuntimeSummary(refreshCompanion?: () => void | Promise<void>): {
  state: ScreenState;
  refreshing: boolean;
  loadSummary: () => Promise<void>;
  onRefresh: () => Promise<void>;
} {
  const { client } = useGateway();
  const [state, setState] = useState<ScreenState>(INITIAL_STATE);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);

  const loadSummary = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    if (!CODING_AGENTS_MOBILE_WORKSPACE || !client) {
      setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
      return;
    }
    const result = await client.getCodingAgentRuntimeSummary();
    if (generation !== requestGeneration.current) return;
    if (result.ok) {
      setState({ status: "ready", summary: result.summary, error: null });
      return;
    }
    setState({ status: "error", summary: null, error: "Runtime summary unavailable" });
  }, [client]);

  useEffect(() => {
    setState((current) => (current.summary ? current : INITIAL_STATE));
    void loadSummary();
    void refreshCompanion?.();
  }, [loadSummary, refreshCompanion]);

  // The workspace is the attention surface: refresh whenever the screen regains
  // focus (returning from a detail route) or the app comes back to the
  // foreground, so stale rows do not linger until a manual pull-to-refresh. The
  // first focus coincides with mount, which already loads, so skip it to avoid a
  // duplicate request.
  const hasFocusedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedOnceRef.current) {
        hasFocusedOnceRef.current = true;
        return;
      }
      void loadSummary();
    }, [loadSummary]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void loadSummary();
    });
    return () => {
      subscription?.remove?.();
    };
  }, [loadSummary]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Match the mount path: the summary and its companion are independent
      // reads, so refresh them concurrently.
      await Promise.all([loadSummary(), refreshCompanion?.()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadSummary, refreshCompanion]);

  return { state, refreshing, loadSummary, onRefresh };
}
