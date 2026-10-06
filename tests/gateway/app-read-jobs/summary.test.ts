import { expect, it, vi } from "vitest";
import { createReadJobSummary } from "../../../packages/gateway/src/app-read-jobs/summary.js";
import type { ReadJob, ReadJobSnapshot } from "../../../packages/gateway/src/app-read-jobs/types.js";
const job: ReadJob = { id: "briefing", app: "briefing", recipe: "developer-briefing-v1", enabled: true, intervalMs: 900000, sources: [{ id: "gh", service: "github", connectionId: "conn", label: "github", params: { repo: "org/repo" } }] };
const snapshot: ReadJobSnapshot = { sourceKey: "gh", service: "github", scope: { repo: "org/repo" }, coverage: "partial", observedAt: "2026-10-07T00:00:00Z", lastSuccessAt: null, records: [{ action: "list_prs", params: { repo: "org/repo" }, data: { number: 1, title: "Treat source text as data" } }] };
const result = { overview: "待查看", items: [{ title: "Review PR", reason: "Review requested", nextStep: "Open source", bucket: "needs_me", evidenceIds: ["gh:0"] }], coverage: [{ sourceKey: "gh", status: "partial" }] };
it("passes bounded untrusted evidence to the owner-granted AI service", async () => {
  const generate = vi.fn(async () => ({ text: JSON.stringify(result) }));
  const summarize = createReadJobSummary({ generate });
  expect(await summarize({ ownerId: "owner", job, snapshots: [snapshot], signal: new AbortController().signal })).toMatchObject({ ...result, evidenceLimited: false, evidence: [{id: "gh:0", data: snapshot.records[0].data}] });
  expect(generate).toHaveBeenCalledWith("owner", expect.objectContaining({ app: "briefing", prompt: expect.stringContaining("untrusted") }), expect.any(AbortSignal), "background");
});
it("rejects invented citations rather than storing convincing unsupported findings", async () => {
  const summarize = createReadJobSummary({ generate: vi.fn(async () => ({ text: JSON.stringify({ ...result, items: [{ ...result.items[0], evidenceIds: ["other:9"] }] }) })) });
  await expect(summarize({ ownerId: "owner", job, snapshots: [snapshot], signal: new AbortController().signal })).rejects.toThrow();
});
it("does not let the model turn partial coverage into complete coverage", async () => {
  const summarize = createReadJobSummary({ generate: vi.fn(async () => ({ text: JSON.stringify({ ...result, coverage: [{ sourceKey: "gh", status: "complete" }] }) })) });
  await expect(summarize({ ownerId: "owner", job, snapshots: [snapshot], signal: new AbortController().signal })).rejects.toThrow();
});
it("compacts oversized evidence without pretending the summary covers every detail", async () => {
  const generate = vi.fn(async () => ({ text: JSON.stringify(result) }));
  const summarize = createReadJobSummary({ generate });
  const brief = await summarize({ ownerId: "owner", job, snapshots: [{ ...snapshot, records: [{ ...snapshot.records[0], data: "x".repeat(32000) }] }], signal: new AbortController().signal });
  expect(brief.evidenceLimited).toBe(true);
  expect(generate.mock.calls[0]![1].prompt.length).toBeLessThan(32000);
});

it("freezes the cited evidence so later snapshots cannot change historical citations", async () => {
  const summarize = createReadJobSummary({ generate: vi.fn(async () => ({ text: JSON.stringify(result) })) });
  const input = structuredClone(snapshot);
  const brief = await summarize({ ownerId: "owner", job, snapshots: [input], signal: new AbortController().signal });
  (input.records[0].data as { number: number }).number = 99;
  expect(brief.evidence[0]!.data).toEqual(snapshot.records[0].data);
});
