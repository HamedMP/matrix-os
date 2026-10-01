import { LocalChatImportDisplayError } from "@matrix-os/contracts/local-chat-import";
import { useMemo } from "react";
import { ChatImportPanel, type NativeChatImportAdapter } from "@matrix-os/ui";
import { invoke, onEvent } from "../../../lib/operator";
import { useConnection } from "../../../stores/connection";
import { useTabs } from "../../../stores/tabs";
export default function ChatImportSection() {
    const connected = useConnection(state => Boolean(state.api));
    const runtimeSlot = useConnection(state => state.runtimeSlot);
    const authGeneration = useConnection(state => state.authGeneration);
    const userId = useConnection(state => state.userId);
    const native = useMemo<NativeChatImportAdapter>(() => {
        const session = { runtimeSlot, authGeneration };
        const pause = () => { void invoke("runtime:chat-import-pause", session).catch((error: unknown) => console.warn("Chat import stop unavailable", error instanceof Error ? error.name : "UnknownError")); };
        return { pause, async select(harness, signal) {
                signal.throwIfAborted();
                signal.addEventListener("abort", pause, { once: true });
                try {
                    const response = await invoke("runtime:chat-import-select", { ...session, harness });
                    signal.throwIfAborted();
                    if (response.status === "error")
                        throw new LocalChatImportDisplayError(response.message);
                    return response.status === "selected" ? response : null;
                }
                finally {
                    signal.removeEventListener("abort", pause);
                }
            }, async apply(selectionId, title, signal, progress) {
                signal.throwIfAborted();
                signal.addEventListener("abort", pause, { once: true });
                const stop = onEvent("runtime:chat-import-progress", event => { if (event.selectionId === selectionId && event.runtimeSlot === runtimeSlot && event.authGeneration === authGeneration && !signal.aborted)
                    progress(event); });
                try {
                    const response = await invoke("runtime:chat-import-apply", { ...session, selectionId, title });
                    signal.throwIfAborted();
                    if (response.status === "error")
                        throw new LocalChatImportDisplayError(response.message);
                    return response.status === "imported" ? response : null;
                }
                finally {
                    stop();
                    signal.removeEventListener("abort", pause);
                }
            } };
    }, [runtimeSlot, authGeneration, userId]);
    if (!connected)
        return <p>Connect to your Matrix computer to import a Chat.</p>;
    return <ChatImportPanel key={`${userId ?? "signed-out"}:${runtimeSlot}:${authGeneration}`} native={native} onOpenChat={(chatId, title) => useTabs.getState().openTab({ kind: "chat", title, chatId, chatView: "conversation", closable: false })}/>;
}
