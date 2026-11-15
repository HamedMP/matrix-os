import { describe, expect, it } from "vitest";
import { classifySiteSlug, siteSlugSuggestionCandidates } from "@matrix-os/contracts";
import {
  createInMemoryEmailInvitations, modeSwitchCopy, needsModeSwitchConfirm, normalizeSlugInput, pageModeOf,
  shareHelperText, shareTriggerState, tabIndicators, EmailInvitationError,
} from "../../packages/ui/src/share/index";

// Outcome: every renderer shows the same Share copy and mode rules. Faults:
// header label priority, a switch that skips confirmation, slug rules drifting
// from the platform's reserved list, stale-revision invite mutations.

const site = (accessMode: "public" | "private_link", status: "published" | "unpublished" = "published") => ({
  id: "11111111-1111-4111-8111-111111111111", appSlug: "a", title: "A", description: "", slug: null,
  url: "https://matrix.page/11111111-1111-4111-8111-111111111111", revision: 1, status, accessMode,
  activeVersion: null, versions: [], config: { data: {}, forms: [] },
});

describe("Matrix.page mode rules", () => {
  it("derives exactly one owner-facing mode", () => {
    expect(pageModeOf(null, false)).toBe("none");
    expect(pageModeOf(site("public", "unpublished"), false)).toBe("none");
    expect(pageModeOf(site("public"), false)).toBe("public");
    expect(pageModeOf(site("private_link"), false)).toBe("private_link");
    expect(pageModeOf(site("public"), true)).toBe("private_email");
  });
  it("confirms only when replacing a different active mode", () => {
    expect(needsModeSwitchConfirm("none", "public")).toBe(false);
    expect(needsModeSwitchConfirm("public", "public")).toBe(false);
    expect(needsModeSwitchConfirm("public", "private_link")).toBe(true);
    expect(needsModeSwitchConfirm("private_email", "public")).toBe(true);
  });
  it("states what is lost in the confirm", () => {
    expect(modeSwitchCopy("private_email", "public", 1)).toEqual({ title: "Switch to public?", body: "1 invited person loses access, and their invites can’t be restored. A Matrix.page app has one access mode at a time.", cta: "Make public" });
    expect(modeSwitchCopy("private_link", "private_email", 0).cta).toBe("Make invite-only");
    expect(modeSwitchCopy("public", "private_link", 0).body).toBe("The public link stops working for visitors. A Matrix.page app has one access mode at a time.");
  });
  it("keeps tab dots and the header label independent of the selected tab", () => {
    expect(tabIndicators("private_link", true)).toEqual({ private: true, organization: true, public: false });
    expect(shareTriggerState("public", true)).toEqual({ label: "Live", icon: "live" });
    expect(shareTriggerState("private_email", true)).toEqual({ label: "Shared", icon: "organization" });
    expect(shareTriggerState("none", false)).toEqual({ label: "Share", icon: "share" });
  });
  it("uses the design's helper copy per tab and state", () => {
    expect(shareHelperText({ tab: "private", pageMode: "public" })).toBe("It’s public now. Inviting people makes it invite-only.");
    expect(shareHelperText({ tab: "organization", pageMode: "none", organizationName: "Finna", orgShared: true })).toBe("Shared — it’s in every Finna member’s launcher.");
    expect(shareHelperText({ tab: "organization", pageMode: "none", collaborativeStep: "required" })).toBe("This app saves data, so sharing takes two quick steps.");
    expect(shareHelperText({ tab: "public", pageMode: "private_link" })).toBe("Publishing makes it public and replaces private access.");
  });
});

describe("friendly paths", () => {
  it("normalizes typing and classifies with the platform's reserved routes", () => {
    expect(normalizeSlugInput("My CRM__app")).toBe("my-crm-app");
    expect(normalizeSlugInput("-x")).toBe("x");
    expect(classifySiteSlug("a")).toBe("invalid");
    expect(classifySiteSlug("assets")).toBe("reserved");
    expect(classifySiteSlug("11111111-1111-4111-8111-111111111111")).toBe("invalid");
    expect(classifySiteSlug("sales-crm")).toBe("valid");
    expect(siteSlugSuggestionCandidates("crm", ["sales-crm"])).toEqual(["crm-sales-crm", "crm-app", "crm-2", "crm-3"]);
    expect(siteSlugSuggestionCandidates("x".repeat(62))).toEqual([]);
  });
});

describe("in-memory email invitation stub", () => {
  const signal = new AbortController().signal;
  it("mirrors 2691 outcomes and enforces revisions", async () => {
    const adapter = createInMemoryEmailInvitations({ now: () => Date.parse("2026-11-15T00:00:00Z"), newId: (() => { let n = 0; return () => `id-${++n}`; })() });
    await expect(adapter.invite("app", { emailAddresses: ["a@b.co"], baseRevision: 0 }, signal)).rejects.toBeInstanceOf(EmailInvitationError);
    await adapter.activate("app", signal);
    const { siteRevision } = await adapter.list("app", signal);
    const result = await adapter.invite("app", { emailAddresses: ["A@b.co", "a@b.co", "nope"], baseRevision: siteRevision }, signal);
    expect(result.results.map((entry) => entry.outcome)).toEqual(["queued", "duplicate_in_batch", "invalid"]);
    const page = await adapter.list("app", signal);
    expect(page.invitations).toMatchObject([{ emailAddress: "a@b.co", state: "pending", expiresAt: "2026-11-22T00:00:00.000Z" }]);
    await expect(adapter.revoke("app", "id-1", { baseRevision: siteRevision, invitationRevision: 1 }, signal)).rejects.toMatchObject({ status: 409 });
    await adapter.revoke("app", "id-1", { baseRevision: page.siteRevision, invitationRevision: 1 }, signal);
    expect((await adapter.list("app", signal)).invitations).toEqual([]);
    await adapter.deactivate("app", signal);
    expect(adapter.active("app")).toBe(false);
  });
});
