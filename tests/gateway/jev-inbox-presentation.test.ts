import { expect, it } from "vitest";
import { formatJevInboxPresentation, formatJevInboxActivitySummary } from "../../packages/gateway/src/jev/inbox-presentation.js";
import { EMAIL_TRIAGE_LABELS } from "@matrix-os/contracts";
const proposal = { kind: "proposal", verified: true, readonly: true, threadId: "thread_fixture", messageCount: 4,
  labels: [EMAIL_TRIAGE_LABELS.coldOutreach], archiveProposal: { removeLabelIds: ["INBOX"] },
  observedAt: "2026-09-26T00:00:00.000Z", requestId: "jev_req_fixture_result" };
it("distinguishes confirmed labels from an unknown write outcome without claiming no changes", () => {
  const { archiveProposal: _archive, ...base } = proposal;
  expect(formatJevInboxPresentation({ ...base, kind: "labeled", readonly: false })).toContain("Confirmed in Gmail");
  const unknown = formatJevInboxPresentation({ ...base, kind: "labeling_unconfirmed", readonly: false });
  expect(unknown).toContain("could not be confirmed"); expect(unknown).not.toContain("No mailbox changes");
});
it("formats bounded server proposal with explicit snapshot and no applied-email claim", () => {
  const text = formatJevInboxPresentation(proposal);
  expect(text).toContain("Read-only Inbox triage proposal"); expect(text).toContain("4 messages");
  expect(text).toContain(EMAIL_TRIAGE_LABELS.coldOutreach); expect(text).toContain("Remove INBOX only");
  expect(text).toContain("No mailbox changes have been made."); expect(text).toContain(proposal.observedAt);
});
it("explains a review skip without incorrectly claiming the owner's labeling permission is disabled", () => {
  const text = formatJevInboxPresentation({ ...proposal, labels: [EMAIL_TRIAGE_LABELS.newsletter, EMAIL_TRIAGE_LABELS.review],
    archiveProposal: null, labelingSkipped: "review_required" });
  expect(text).toContain("Review required");
  expect(text).toContain("Labeling permission is enabled");
  expect(text).toContain("No mailbox changes");
  expect(text).not.toContain("permission is disabled");
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
it("shows confirmed, Review and unconfirmed batch progress without claiming unfinished Inbox completion",()=>{
 const batch={kind:"batch",revision:1,jobId:"jev_batch_"+"a".repeat(32),status:"paused",processed:3,labeled:1,review:1,preview:0,unconfirmed:1,
  messagesLabeled:2,remainingQueued:4,hasMore:true,maxThreads:10000,last:{threadId:"thread_3",status:"unconfirmed"}};
 const text=formatJevInboxPresentation(batch);
 expect(text).toContain("Confirmed: 1 threads / 2 messages");expect(text).toContain("Review: 1");expect(text).toContain("Unconfirmed: 1");
 expect(text).toContain("Resume");expect(text).not.toContain("Whole Inbox complete");
 expect(formatJevInboxPresentation({...batch,labeled:999})).toBeNull();
});
it("presents no saved batch as an empty state rather than an unconfirmed mutation",()=>{
 expect(formatJevInboxPresentation({kind:"batch_absent"})).toContain("No saved Inbox batch");
 expect(formatJevInboxPresentation({kind:"batch_absent"})).not.toContain("unconfirmed");
});

it("shows compact verified batch counters during tool activity",()=>{
 const value={kind:"batch",revision:1,jobId:"jev_batch_"+"a".repeat(32),status:"ready",processed:3,labeled:2,review:1,preview:0,unconfirmed:0,messagesLabeled:3,remainingQueued:4,hasMore:true,maxThreads:6,last:null};
 expect(formatJevInboxActivitySummary(value)).toBe("Inbox batch: 3 examined, 2 confirmed, 0 no change, 1 Review, 0 unconfirmed (ready)");
 expect(formatJevInboxActivitySummary({...value,processed:999})).toBeNull();
});
