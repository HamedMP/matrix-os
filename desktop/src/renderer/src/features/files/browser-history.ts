import { useCallback, useMemo, useState } from "react";

interface BrowserHistoryState {
  paths: string[];
  index: number;
}

const INITIAL_HISTORY: BrowserHistoryState = { paths: [""], index: 0 };

export function useBrowserHistory() {
  const [history, setHistory] = useState<BrowserHistoryState>(INITIAL_HISTORY);
  const currentPath = history.paths[history.index] ?? "";

  const resetHistory = useCallback(() => setHistory(INITIAL_HISTORY), []);
  const pushPath = useCallback((path: string) => {
    setHistory((current) => ({
      paths: [...current.paths.slice(0, current.index + 1), path],
      index: current.index + 1,
    }));
  }, []);

  const controls = useMemo(() => ({
    canGoBack: history.index > 0,
    canGoForward: history.index < history.paths.length - 1,
    backPath: history.index > 0 ? history.paths[history.index - 1] ?? null : null,
    forwardPath: history.index < history.paths.length - 1 ? history.paths[history.index + 1] ?? null : null,
  }), [history]);

  const moveBack = useCallback(() => {
    if (!controls.canGoBack) return;
    setHistory((current) => ({ ...current, index: current.index - 1 }));
  }, [controls.canGoBack]);
  const moveForward = useCallback(() => {
    if (!controls.canGoForward) return;
    setHistory((current) => ({ ...current, index: current.index + 1 }));
  }, [controls.canGoForward]);

  return { currentPath, resetHistory, pushPath, moveBack, moveForward, ...controls };
}
