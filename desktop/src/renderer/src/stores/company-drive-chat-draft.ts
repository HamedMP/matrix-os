import { create } from "zustand";
import { CanonicalChatResourceReferenceSchema, type CanonicalChatResourceReference } from "@matrix-os/contracts";
import { useConnection } from "./connection";
import { useTabs } from "./tabs";
type Request = {
    id: string;
    identity: string;
    tabId: string;
    createdAt: number;
    /** A Company Drive resource, or none for a text-only draft (Share → Start in Chats). */
    reference: CanonicalChatResourceReference | null;
    /** Composer text prefilled for the owner to send. */
    text: string;
};
export function desktopDriveDraftIdentity(state: Pick<ReturnType<typeof useConnection.getState>, "userId" | "platformHost" | "runtimeSlot" | "authGeneration">): string {
    return JSON.stringify([state.userId, state.platformHost, state.runtimeSlot, state.authGeneration]);
}
/** One bounded, expiring intent targeted to the Chat tab; no submission or persisted Chat data. */
export const useDesktopCompanyDriveChatDraft = create<{
    request: Request | null;
    consume(request: Request): void;
}>(set => ({
    request: null, consume: request => set(current => current.request === request ? { request: null } : {})
}));
export function openDesktopCompanyDriveChat(reference: CanonicalChatResourceReference, identity: string): void {
    const connection = useConnection.getState();
    if (desktopDriveDraftIdentity(connection) !== identity)
        return;
    const parsed = CanonicalChatResourceReferenceSchema.parse(reference);
    if (parsed.kind !== "organization_drive")
        return;
    const tabId = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
    useDesktopCompanyDriveChatDraft.setState({ request: { id: crypto.randomUUID(), identity, tabId, createdAt: Date.now(), reference: parsed, text: "" } });
}
/**
 * Opens the visible Chat surface on a new draft with `text` in its composer
 * (bounded; the owner sends it). Used by the Share popover's collaborative
 * handoff; returns false when no runtime identity is signed in.
 */
export function openDesktopTextChatDraft(text: string): boolean {
    const connection = useConnection.getState();
    if (!connection.userId || text.length === 0 || text.length > 4000)
        return false;
    const tabId = useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
    useDesktopCompanyDriveChatDraft.setState({ request: { id: crypto.randomUUID(), identity: desktopDriveDraftIdentity(connection), tabId, createdAt: Date.now(), reference: null, text } });
    return true;
}
export function applicableDesktopCompanyDriveDraft(request: Request, identity: string, tabId: string | undefined, now = Date.now()): boolean {
    const tabs = useTabs.getState(), tab = tabs.tabs.find(item => item.id === tabId);
    return request.identity === identity && request.tabId === tabId && tabs.activeTabId === tabId
        && tab?.kind === "work" && tab.workRoute === "chat" && tab.chatView === "draft" && !tab.chatId && !tab.sharedScopeId
        && now >= request.createdAt && now - request.createdAt <= 10 * 60000;
}
