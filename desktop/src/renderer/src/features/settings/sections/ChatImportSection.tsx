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
        const pause = (discardSelections = false) => { void invoke("runtime:chat-import-pause", { ...session, discardSelections }).catch((error: unknown) => console.warn("Chat import stop unavailable", error instanceof Error ? error.name : "UnknownError")); };
        return { pause, async reserve(sourceKeys, signal) {
                signal.throwIfAborted(); const abort=()=>pause(); signal.addEventListener("abort",abort,{once:true});
                try {
                    const response=await invoke("runtime:chat-import-reserve",{...session,sourceKeys});signal.throwIfAborted();
                    if(!response.ok)throw new LocalChatImportDisplayError("Local conversations changed. Refresh the list and select them again.");
                }finally{signal.removeEventListener("abort",abort);}
            }, async release(selectionIds) {
                const response=await invoke("runtime:chat-import-release",{...session,selectionIds});
                if(!response.ok)throw new LocalChatImportDisplayError("Local conversations changed. Refresh the list and select them again.");
            }, async discover(signal) {
                signal.throwIfAborted(); const abort = () => pause(); signal.addEventListener("abort", abort, {once:true});
                try {
                    const response = await invoke("runtime:chat-import-discover", session); signal.throwIfAborted();
                    if(response.status === "error") throw new LocalChatImportDisplayError(response.message);
                    return response.status === "discovered" ? response : null;
                } finally { signal.removeEventListener("abort", abort); }
            }, async prepare(sourceKeys, signal) {
                signal.throwIfAborted(); const abort = () => pause(); signal.addEventListener("abort", abort, {once:true});
                try {
                    const response = await invoke("runtime:chat-import-prepare", {...session, sourceKeys}); signal.throwIfAborted();
                    if(response.status === "error") throw new LocalChatImportDisplayError(response.message);
                    return response.status === "selected-many" ? response : null;
                } finally { signal.removeEventListener("abort", abort); }
            }, async apply(selectionId, title, signal, progress) {
                signal.throwIfAborted();
                const abort = () => pause();
                signal.addEventListener("abort", abort, { once: true });
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
                    signal.removeEventListener("abort", abort);
                }
            } };
    }, [runtimeSlot, authGeneration, userId]);
    if (!connected)
        return <p>Connect to your Matrix computer to import a Chat.</p>;
    return <ChatImportPanel key={`${userId ?? "signed-out"}:${runtimeSlot}:${authGeneration}`} native={native} onOpenChat={(chatId, title) => useTabs.getState().openTab({ kind: "chat", title, chatId, chatView: "conversation", closable: false })}/>;
}
