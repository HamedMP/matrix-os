import { JevEmailTriageScoresSchema, type JevEmailTriageScores } from "@matrix-os/contracts";
export const NEWSLETTER_POLICY_VERSION = "newsletter-v1-manual";
export const NEWSLETTER_POLICY_LIMITS = { confirmed: .9, review: .5, exclusion: .2 } as const;
export type NewsletterCategory = "newsletter" | "review" | "excluded";
export function newsletterPolicy(raw: JevEmailTriageScores, verified: boolean, correction?: NewsletterCategory | null) {
    const scores = JevEmailTriageScoresSchema.parse(raw);
    const conflict = scores.urgent > NEWSLETTER_POLICY_LIMITS.exclusion || scores.needs_reply > NEWSLETTER_POLICY_LIMITS.exclusion || scores.personal_intro > NEWSLETTER_POLICY_LIMITS.exclusion || scores.investment > NEWSLETTER_POLICY_LIMITS.exclusion || scores.recruiting > NEWSLETTER_POLICY_LIMITS.exclusion || scores.cold_outreach > NEWSLETTER_POLICY_LIMITS.exclusion;
    const category: NewsletterCategory = correction ?? (verified && scores.newsletter >= NEWSLETTER_POLICY_LIMITS.confirmed && !conflict ? "newsletter" : scores.newsletter >= NEWSLETTER_POLICY_LIMITS.review || conflict ? "review" : "excluded");
    // Publication automation deliberately has no enabling path until a reviewed calibration ships.
    return { category, automaticArchive: false as const, policyVersion: NEWSLETTER_POLICY_VERSION };
}
