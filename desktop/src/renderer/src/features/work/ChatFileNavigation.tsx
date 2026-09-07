import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { InspectorFileTarget } from "../panels/InspectorFilesPanel";

interface FileRequest {
  chatId: string;
  target: InspectorFileTarget;
}

const ChatFileNavigation = createContext<{
  request: FileRequest | null;
  open: (request: FileRequest) => void;
} | null>(null);

export function ChatFileNavigationProvider({ children, reveal }: {
  children: ReactNode;
  reveal: () => void;
}) {
  const [request, setRequest] = useState<FileRequest | null>(null);
  const open = useCallback((next: FileRequest) => {
    setRequest(next);
    reveal();
  }, [reveal]);
  const value = useMemo(() => ({ request, open }), [request, open]);
  return <ChatFileNavigation.Provider value={value}>{children}</ChatFileNavigation.Provider>;
}

export function useChatFileNavigation() {
  return useContext(ChatFileNavigation);
}
