import { useEffect, useState } from "react";
import type { ChatDriveProject } from "@matrix-os/contracts";
import type { ChatDriveProjectClient } from "./chat-project-client.js";
/** Revisions refresh associations after durable Chat events; old clients and runtime results are ignored. */
export function useChatDriveProjects(client: ChatDriveProjectClient | undefined, chats: readonly {
    id: string;
    revision?: number;
}[], active = true) {
    const key = JSON.stringify(chats.slice(0, 1000).map(chat => [chat.id, chat.revision]));
    const [state, setState] = useState<{
        client: ChatDriveProjectClient;
        key: string;
        associations: ChatDriveProject[];
        error?: boolean;
    } | null>(null);
    useEffect(() => {
        if (!client || !active)
            return;
        let current = true;
        const ids = JSON.parse(key).map((row: [
            string,
            number?
        ]) => row[0]) as string[];
        const timer = setTimeout(() => {
            void client.lookup(ids).then(associations => { if (current)
                setState({ client, key, associations }); }).catch((error: unknown) => {
                console.warn("[chat/drive-projects] Unavailable", error instanceof Error ? error.name : "UnknownError");
                if (current)
                    setState({ client, key, associations: [], error: true });
            });
        }, 120);
        return () => { current = false; clearTimeout(timer); };
    }, [client, key, active]);
    const current = state && state.client === client && state.key === key && active ? state : null;
    return { associations: current?.associations ?? [], error: current?.error === true, loading: Boolean(client && active && !current) };
}
