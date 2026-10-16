import { useCallback, useEffect, useRef, useState } from "react";

export function usePullToRefresh(refreshPage: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const refreshPageRef = useRef(refreshPage);
  const refreshInFlight = useRef(false);
  const mounted = useRef(true);
  refreshPageRef.current = refreshPage;

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const onRefresh = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);

    void refreshPageRef.current()
      .catch((error: unknown) => {
        console.warn(
          "[mobile] page refresh failed",
          error instanceof Error ? error.name : "unknown",
        );
      })
      .finally(() => {
        refreshInFlight.current = false;
        if (mounted.current) setRefreshing(false);
      });
  }, []);

  return { refreshing, onRefresh };
}
