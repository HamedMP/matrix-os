import { afterEach, expect, it } from "vitest";
import { applicableCompanyDriveDraft, useCompanyDriveChatDraft } from "../../shell/src/stores/company-drive-chat-draft";
const ref = { kind: "organization_drive" as const, id: "00000000-0000-4000-8000-000000000001", label: "Authority", drive: { kind: "drive" as const, organizationId: "org_company", scopeId: "00000000-0000-4000-8000-000000000001" } };
afterEach(() => useCompanyDriveChatDraft.setState({ request: null }));
it("retains one identity-bound intent, expires it and consumes only the exact current request", () => {
    const state = useCompanyDriveChatDraft.getState();
    state.open(ref, "owner/session/runtime");
    const old = useCompanyDriveChatDraft.getState().request!;
    expect(applicableCompanyDriveDraft(old, "other/session/runtime")).toBe(false);
    expect(applicableCompanyDriveDraft(old, old.identity, old.createdAt + 600001)).toBe(false);
    expect(applicableCompanyDriveDraft(old, old.identity, old.createdAt)).toBe(true);
    state.open(ref, "owner/session/runtime");
    const current = useCompanyDriveChatDraft.getState().request!;
    state.consume(old);
    expect(useCompanyDriveChatDraft.getState().request).toBe(current);
    state.consume(current);
    expect(useCompanyDriveChatDraft.getState().request).toBeNull();
});
