import { create } from "zustand";
import { CanonicalChatResourceReferenceSchema, type CanonicalChatResourceReference } from "@matrix-os/contracts";
import { useConnection } from "./connection";
import { useTabs } from "./tabs";
type Request = {
    id: string;
    identity: string;
    tabId: string;
    createdAt: number;
    reference: CanonicalChatResourceReference;
    references?: CanonicalChatResourceReference[];
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
    useDesktopCompanyDriveChatDraft.setState({ request: { id: crypto.randomUUID(), identity, tabId, createdAt: Date.now(), reference: parsed } });
}
export function applicableDesktopCompanyDriveDraft(request: Request, identity: string, tabId: string | undefined, now = Date.now()): boolean {
    const tabs = useTabs.getState(), tab = tabs.tabs.find(item => item.id === tabId);
    return request.identity === identity && request.tabId === tabId && tabs.activeTabId === tabId
        && tab?.kind === "work" && tab.workRoute === "chat" && tab.chatView === "draft" && !tab.chatId && !tab.sharedScopeId
        && now >= request.createdAt && now - request.createdAt <= 10 * 60000;
}

export function openDesktopMemoryChat(references: CanonicalChatResourceReference[], identity: string): void {
  if (desktopDriveDraftIdentity(useConnection.getState()) !== identity) return;
  const parsed = references.map(value => CanonicalChatResourceReferenceSchema.parse(value));
  if (!parsed.length || parsed.length > 8 || parsed.some(value => value.kind !== "memory_source") || new Set(parsed.map(value=>value.id)).size!==parsed.length) throw new Error("Invalid memory selection");
  const tabId = useTabs.getState().openTab({kind:"work",title:"Chat",workRoute:"chat",chatView:"draft",closable:false});
  useDesktopCompanyDriveChatDraft.setState({request:{id:crypto.randomUUID(),identity,tabId,createdAt:Date.now(),reference:parsed[0]!,references:parsed}});
}
