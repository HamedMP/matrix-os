import { describe, it, expect } from "vitest";
import { newsletterPolicy, NEWSLETTER_POLICY_VERSION } from "../../packages/gateway/src/mail/policy.js";
const scores = { urgent: 0, needs_reply: 0, personal_intro: 0, investment: 0, recruiting: 0, newsletter: .98, cold_outreach: 0 };
describe("newsletter policy", () => {
    it("never enables automation before calibrated reviewed policy", () => { expect(newsletterPolicy(scores, true).automaticArchive).toBe(false); expect(NEWSLETTER_POLICY_VERSION).toContain("v1"); });
    it("puts uncertain or conflicting newsletter evidence in Review", () => { expect(newsletterPolicy({ ...scores, needs_reply: .4 }, true).category).toBe("review"); expect(newsletterPolicy(scores, false).category).toBe("review"); });
    it("preserves explicit correction including exclusion", () => { expect(newsletterPolicy(scores, true, "excluded").category).toBe("excluded"); expect(newsletterPolicy({ ...scores, newsletter: .1 }, true, "newsletter").category).toBe("newsletter"); });
});
it("excludes non-newsletter without conflicts and rejects every important conflict", () => { expect(newsletterPolicy({ ...scores, newsletter: .1 }, true).category).toBe('excluded'); for (const field of ['urgent', 'personal_intro', 'investment', 'recruiting', 'cold_outreach'] as const)
    expect(newsletterPolicy({ ...scores, [field]: .9 }, true).category).toBe('review'); });
