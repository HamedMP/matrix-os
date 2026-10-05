import { create } from "zustand";
import { CanonicalChatResourceReferenceSchema, type CanonicalChatResourceReference } from "@matrix-os/contracts";
type Request = {
    id: string;
    identity: string;
    createdAt: number;
    reference: CanonicalChatResourceReference;
    references?: CanonicalChatResourceReference[];
};
/** One short-lived, identity-bound editable draft intent; no Chat content or automatic submission. */
export const useCompanyDriveChatDraft = create<{
    request: Request | null;
    open(reference: CanonicalChatResourceReference, identity: string): void;
    openMemory(references: CanonicalChatResourceReference[], identity: string): void;
    consume(request: Request): void;
}>(set => ({
    request: null,
    openMemory: (references, identity) => {
      const parsed = references.map(value => CanonicalChatResourceReferenceSchema.parse(value));
      if (!parsed.length || parsed.length > 8 || parsed.some(value => value.kind !== "memory_source") || new Set(parsed.map(value=>value.id)).size!==parsed.length) throw new Error("Invalid memory selection");
      set({request:{id:crypto.randomUUID(),identity,createdAt:Date.now(),reference:parsed[0]!,references:parsed}});
    },
    open: (reference, identity) => set({ request: { id: crypto.randomUUID(), identity, createdAt: Date.now(), reference: CanonicalChatResourceReferenceSchema.parse(reference) } }), consume: request => set(current => current.request === request ? { request: null } : {})
}));
export function applicableCompanyDriveDraft(request: Request, identity: string, now = Date.now()): boolean { return request.identity === identity && now >= request.createdAt && now - request.createdAt <= 10 * 60000; }
export const COMPANY_DRIVE_MOBILE_CHAT_EVENT = "matrix:company-drive-mobile-chat";
