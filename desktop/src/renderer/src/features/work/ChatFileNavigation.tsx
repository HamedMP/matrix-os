import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { InspectorFileTarget } from "../panels/InspectorFilesPanel";

interface FileRequest {
  chatId: string;
  target: InspectorFileTarget;
}

const ChatFileNavigation = createContext<{
  request: FileRequest | null;
  open: (request: FileRequest) => void;
} | null>(null);

export function ChatFileNavigationProvider({ children, reveal, scopeKey = "default" }: {
  children: ReactNode;
  reveal: () => void;
  scopeKey?: string;
}) {
  const [state, setState] = useState<{ scopeKey: string; request: FileRequest | null }>({ scopeKey, request: null });
  // Reset only inspector state, never remount the subtree that owns Chat drafts.
  if (state.scopeKey !== scopeKey) setState({ scopeKey, request: null });
  const scope = useMemo(() => ({}), [scopeKey]);
  const committedScope = useRef<object | null>(scope);
  useLayoutEffect(() => {
    committedScope.current = scope;
    return () => { committedScope.current = null; };
  }, [scope]);
  const open = useCallback((next: FileRequest) => {
    if (committedScope.current !== scope) return;
    setState({ scopeKey, request: next });
    reveal();
  }, [reveal, scope, scopeKey]);
  const request = state.scopeKey === scopeKey ? state.request : null;
  const value = useMemo(() => ({ request, open }), [request, open]);
  return <ChatFileNavigation.Provider value={value}>{children}</ChatFileNavigation.Provider>;
}

export function useChatFileNavigation() {
  return useContext(ChatFileNavigation);
}
