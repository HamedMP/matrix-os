import type { JevEmailTriageScores } from "@matrix-os/contracts";

export const EMAIL_TRIAGE_LABELS = {
  urgent: "00 • Jev/1 Urgent",
  needsReply: "00 • Jev/2 Needs reply",
  personalIntro: "00 • Jev/3 Personal & intros",
  investment: "00 • Jev/4 Investment",
  recruiting: "00 • Jev/5 Recruiting",
  newsletter: "00 • Jev/8 Newsletter",
  coldOutreach: "00 • Jev/9 Cold outreach",
  review: "00 • Jev/Z Review",
} as const;

export interface EmailTriagePolicyInput {
  scores: JevEmailTriageScores;
  verified: boolean;
  ageDays: number;
}

export interface EmailTriagePolicyResult {
  scores: JevEmailTriageScores;
  requiresFullContext: boolean;
  labels: string[];
  archive: { removeLabelIds: ["INBOX"] } | null;
}

export function evaluateEmailTriagePolicy(input: EmailTriagePolicyInput): EmailTriagePolicyResult {
  const { scores, verified } = input;
  const ageDays = Number.isFinite(input.ageDays) && input.ageDays >= 0 ? input.ageDays : Number.POSITIVE_INFINITY;
  const requiresFullContext = !verified && (
    scores.cold_outreach >= 0.75
    || scores.urgent >= 0.40
    || scores.needs_reply >= 0.70
  );

  const urgent = ageDays <= 30
    && scores.urgent >= (verified ? 0.55 : 0.70)
    && scores.newsletter < 0.80
    && scores.cold_outreach < 0.80;
  const needsReply = ageDays <= 90
    && scores.needs_reply >= (verified ? 0.75 : 0.85)
    && scores.newsletter < 0.75
    && scores.cold_outreach < 0.85;
  const personalIntro = scores.personal_intro >= (verified ? 0.75 : 0.85);
  const investment = scores.investment >= (verified ? 0.75 : 0.85);
  const recruiting = scores.recruiting >= (verified ? 0.75 : 0.85);
  const newsletter = scores.newsletter >= (verified ? 0.85 : 0.90);
  const coldOutreach = scores.cold_outreach >= (verified ? 0.85 : 0.90);

  const mayArchive = verified
    && scores.cold_outreach >= 0.92
    && scores.urgent <= 0.20
    && scores.needs_reply <= 0.20
    && scores.personal_intro <= 0.30
    && scores.investment <= 0.20
    && scores.recruiting <= 0.20;

  const review = !mayArchive && ageDays <= 90 && (
    scores.cold_outreach >= 0.65
    || (scores.urgent >= 0.40 && !urgent)
    || (
      scores.needs_reply >= 0.65
      && !needsReply
      && scores.newsletter < 0.75
      && scores.cold_outreach < 0.85
    )
  );

  const labels: string[] = [];
  if (urgent) labels.push(EMAIL_TRIAGE_LABELS.urgent);
  if (needsReply) labels.push(EMAIL_TRIAGE_LABELS.needsReply);
  if (personalIntro) labels.push(EMAIL_TRIAGE_LABELS.personalIntro);
  if (investment) labels.push(EMAIL_TRIAGE_LABELS.investment);
  if (recruiting) labels.push(EMAIL_TRIAGE_LABELS.recruiting);
  if (newsletter) labels.push(EMAIL_TRIAGE_LABELS.newsletter);
  if (coldOutreach) labels.push(EMAIL_TRIAGE_LABELS.coldOutreach);
  if (review) labels.push(EMAIL_TRIAGE_LABELS.review);

  return {
    scores,
    requiresFullContext,
    labels,
    archive: mayArchive ? { removeLabelIds: ["INBOX"] } : null,
  };
}
