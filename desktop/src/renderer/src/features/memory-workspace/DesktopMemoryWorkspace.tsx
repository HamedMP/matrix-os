import { useMemo } from "react";
import {
  MemoryWorkspace,
  createMemoryWorkspaceClient,
  memoryContextChatReferences,
  type MemoryTransport,
} from "@matrix-os/ui";
import type {
  MemoryContextResult,
} from "@matrix-os/contracts";
import "@matrix-os/ui/memory-workspace.css";
import { useConnection } from "../../stores/connection";
import { useTabs, FILES_WORKSPACE_TAB_SPEC } from "../../stores/tabs";
import {
  desktopDriveDraftIdentity,
  openDesktopMemoryChat,
} from "../../stores/company-drive-chat-draft";
export default function DesktopMemoryWorkspace() {
  const connectionApi = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const api = useMemo(
    () => connectionApi?.forRuntime(runtimeSlot) ?? null,
    [connectionApi, runtimeSlot],
  );
  const identity = useConnection(desktopDriveDraftIdentity);
  const client = useMemo(
    () =>
      api
        ? createMemoryWorkspaceClient({
            request: <T,>(
              method: Parameters<MemoryTransport["request"]>[0],
              path: string,
              body?: unknown,
            ) =>
              method === "GET"
                ? api.get<T>(path, { timeoutMs: 45_000, maxBytes: 4_000_000 })
                : method === "DELETE"
                  ? api.delete<T>(path)
                  : method === "PATCH"
                    ? api.patch<T>(path, body)
                    : api.post<T>(path, body, {
                        timeoutMs: 45_000,
                        maxBytes: 4_000_000,
                      }),
          })
        : null,
    [api],
  );
  const nativeImport = useMemo(
    () => ({
      invoke: (command: string, payload: unknown) =>
        window.operator.invoke(command, payload),
    }),
    [],
  );
  async function useInChat(sourceIds: string[]) {
    if (!api) return;
    const context = await api.post<MemoryContextResult>(
      "/api/memory-workspace/context",
      { sourceIds },
    );
    if (desktopDriveDraftIdentity(useConnection.getState()) !== identity)
      return;
    const references = memoryContextChatReferences(context);
    openDesktopMemoryChat(references, identity);
  }
  if (!client)
    return (
      <div style={{ padding: 32 }}>
        Connect to your Matrix computer to open Memory.
      </div>
    );
  return (
    <MemoryWorkspace
      client={client}
      identity={identity}
      nativeImport={nativeImport}
      onUseInChat={useInChat}
      onOpenFiles={() => useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC)}
    />
  );
}
