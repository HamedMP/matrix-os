import { ChatImportPanel } from "@matrix-os/ui";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";

export default function ChatImportSection() {
  const api = useConnection((state) => state.api);
  const identity = useConnection((state) => `${state.userId ?? "signed-out"}:${state.runtimeSlot}:${state.authGeneration}`);
  if (!api) return <p>Connect to your Matrix computer to import a Chat.</p>;
  const pinned = api.forRuntime(useConnection.getState().runtimeSlot);
  return <ChatImportPanel key={identity} request={(path, body) => body === undefined
    ? pinned.get<unknown>(path, { timeoutMs: 30_000 })
    : pinned.post<unknown>(path, body, { timeoutMs: path.endsWith("/complete") ? 5 * 60_000 : 30_000 })}
    onOpenChat={(chatId, title) => useTabs.getState().openTab({
      kind: "chat", title, chatId, chatView: "conversation", closable: false,
    })} />;
}
