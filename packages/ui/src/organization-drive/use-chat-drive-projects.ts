import { useEffect, useMemo, useState } from "react";
import type { ChatDriveProject } from "@matrix-os/contracts";
import type { ChatDriveProjectClient } from "./chat-project-client.js";
/** Same-identity refreshes retain loaded rows; identity changes and hidden panes clear them. */
export function useChatDriveProjects(client: ChatDriveProjectClient | undefined, chats: readonly {
    id: string;
    revision?: number;
}[], active = true) {
    const key = JSON.stringify(chats.slice(0, 1000).map(chat => [chat.id, chat.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const ids = useMemo(() => (JSON.parse(key) as [
        string,
        number?
    ][]).map(row => row[0]), [key]);
    const [state, setState] = useState<{
        client: ChatDriveProjectClient;
        key: string;
        associations: ChatDriveProject[];
        error?: boolean;
    } | null>(null);
    useEffect(() => {
        if (!client || !active) {
            setState(null);
            return;
        }
        setState(previous => previous?.client === client ? previous : null);
        let current = true;
        const timer = setTimeout(() => {
            void client.lookup(ids).then(associations => {
                if (current)
                    setState({ client, key, associations });
            }).catch((error: unknown) => {
                console.warn("[chat/drive-projects] Unavailable", error instanceof Error ? error.name : "UnknownError");
                if (current)
                    setState(previous => ({ client, key, associations: previous?.client === client ? previous.associations.filter(row => ids.includes(row.chatId)) : [], error: true }));
            });
        }, 120);
        return () => { current = false; clearTimeout(timer); };
    }, [client, key, ids, active]);
    const current = state?.client === client && active ? state : null;
    const associations = useMemo(() => current?.associations.filter(row => ids.includes(row.chatId)) ?? [], [current, ids]);
    return { associations, error: current?.error === true, loading: Boolean(client && active && !current), refreshing: Boolean(current && current.key !== key) };
}
