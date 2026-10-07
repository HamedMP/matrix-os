import { expect, it } from "vitest";
import {
  parseMessage,
  parseSources,
} from "../../home/app-templates/connected-starter/src/edition/transport";
import { sourceStatus } from "../../home/app-templates/connected-starter/src/edition/source-status";
import { EditionDownloads } from "../../home/app-templates/connected-starter/src/edition/offline";
const source = {
  id: "s1",
  connectionId: "c1",
  email: "reader@example.test",
  label: "Reading",
  scope: "personal",
  state: "running",
  availability: "connected",
  coverageStart: "2026-07-07T00:00:00Z",
  retainedCount: 72,
  classifiedCount: 58,
  reviewPendingCount: 9,
  partialCount: 5,
  observedScope: "account_total",
  observed: {
    connectorCalls: 12,
    messageRetrievals: 8,
    reusedBodies: 64,
    aiClassificationCalls: 58,
    classificationReuse: 10,
    byAction: { get_message: 8 },
  },
  billedUsage: null,
};
it("preserves real source progress and distinguishes observed activity from billed usage", () => {
  const parsed = parseSources({ sources: [source] }).sources[0];
  expect(sourceStatus(parsed)).toContain(
    "72 retained · 58 categorized · 9 to review · 5 partial",
  );
  expect(sourceStatus(parsed)).toContain(
    "Observed account activity · 12 connector calls · 64 reused emails · 58 AI categorizations",
  );
  expect(sourceStatus(parsed)).toContain("Billed usage is not available.");
  expect(
    sourceStatus(
      parseSources({
        sources: [
          {
            ...source,
            availability: "disconnected",
            syncError: "sync_unavailable",
          },
        ],
      }).sources[0],
    ),
  ).toContain(
    "Email connection is disconnected. Reconnect in Matrix to import new editions.",
  );
});
it("does not invent source counters and rejects malformed progress", () => {
  expect(
    sourceStatus(
      parseSources({
        sources: [
          {
            id: "s1",
            connectionId: "c1",
            email: "reader@example.test",
            label: "Reading",
            scope: "personal",
            state: "pending",
          },
        ],
      }).sources[0],
    ).join(" "),
  ).not.toContain("0 retained");
  expect(() =>
    parseSources({ sources: [{ ...source, retainedCount: -1 }] }),
  ).toThrow();
});
it("never stores partial placeholder content as an offline download", () => {
  const message = parseMessage({
    id: "m1",
    sourceId: "s1",
    subject: "Partial",
    sender: "Publication",
    publication: "Publication",
    receivedAt: "2026-10-07T00:00:00Z",
    excerpt: "Preview",
    text: "This message has not been downloaded completely.",
    contentVersion: "partial-1",
    classification: "newsletter",
    saved: false,
    read: false,
    progress: 0,
    revision: 1,
    readingRevision: 0,
    partial: true,
  });
  expect(message.partial).toBe(true);
  const cache = new EditionDownloads(
    { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    "owner-computer",
  );
  expect(() => cache.download(message)).toThrow();
});
