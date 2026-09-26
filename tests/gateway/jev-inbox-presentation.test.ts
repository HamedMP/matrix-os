import { expect, it } from "vitest";
import { formatJevInboxPresentation } from "../../packages/gateway/src/jev/inbox-presentation.js";
import { EMAIL_TRIAGE_LABELS } from "@matrix-os/contracts";
const proposal = { kind: "proposal", verified: true, readonly: true, threadId: "thread_fixture", messageCount: 4,
  labels: [EMAIL_TRIAGE_LABELS.coldOutreach], archiveProposal: { removeLabelIds: ["INBOX"] },
  observedAt: "2026-09-26T00:00:00.000Z", requestId: "jev_req_fixture_result" };
it("formats bounded server proposal with explicit snapshot and no applied-email claim", () => {
  const text = formatJevInboxPresentation(proposal);
  expect(text).toContain("Read-only Inbox triage proposal"); expect(text).toContain("4 messages");
  expect(text).toContain(EMAIL_TRIAGE_LABELS.coldOutreach); expect(text).toContain("Remove INBOX only");
  expect(text).toContain("No mailbox changes have been made."); expect(text).toContain(proposal.observedAt);
});
it("retains a broker-valid maximum-length thread identifier", () => {
  expect(formatJevInboxPresentation({ ...proposal, threadId: "t".repeat(160) })).toContain("t".repeat(160));
});
it("keeps incomplete context explicitly Review and unverified", () => {
  const text = formatJevInboxPresentation({ kind: "review", verified: false, readonly: true,
    labels: [EMAIL_TRIAGE_LABELS.review], archiveProposal: null });
  expect(text).toContain("Review — context is unverified"); expect(text).not.toContain("Verified");
});
it.each([
  undefined,
  { ...proposal, labels: ["Bearer fixture-secret-token"] },
  { ...proposal, threadId: "/private/owner/path" },
  { ...proposal, readonly: false },
  { ...proposal, messageCount: 5 },
  { ...proposal, archiveProposal: { removeLabelIds: ["SENT"] } },
  { ...proposal, rawBody: "private email" },
])("withholds malformed or untrusted summary %j", value => {
  expect(formatJevInboxPresentation(value)).toBeNull();
});
