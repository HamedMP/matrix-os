import { afterEach, describe, expect, it } from "vitest";
import type { BrainIntegrationCallOutcome, BrainLinearSourceConfig } from "../../packages/gateway/src/brain/contracts.js";
import { createBrainLinearHandler } from "../../packages/gateway/src/brain/sources/connectors/index.js";
import { linearIssueDocumentId } from "../../packages/gateway/src/brain/sources/connectors/linear.js";
import { connectorDocumentId } from "../../packages/gateway/src/brain/sources/connectors/text.js";
import {
  connectorHarness, connectorProject, connectorScope, fakeIntegrations, ok, type ConnectorHarness,
  type FakeRoute,
} from "./helpers/brain-source-connectors-fakes.js";

let harness: ConnectorHarness | null = null;
afterEach(async () => {
  await harness?.destroy();
  harness = null;
});

const config: BrainLinearSourceConfig = {
  teamKeys: ["ENG"], accountLabel: "work", include: { issues: true, comments: true, projectUpdates: true },
};
const WINDOW_START = "2025-10-01T10:00:00.000Z";

function issue(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `issue-${n}`, identifier: `ENG-${n}`, title: `Fix ${n}`, description: `Details ${n}`,
    url: `https://linear.app/acme/issue/ENG-${n}/fix`, updatedAt: `2026-09-0${n}T00:00:00.000Z`,
    dueDate: "2026-10-10", creator: { id: "user-1" }, assignee: { id: "user-2" },
    state: { name: "In Progress", type: "started" }, labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
    project: { name: "Brain" }, archivedAt: null, ...extra,
  };
}
const connection = (field: string, nodes: unknown[], endCursor: string | null = null) =>
  ok({ data: { [field]: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } });

function setup(routes: Record<string, FakeRoute>, providerTimeoutMs = 10_000) {
  const integrations = fakeIntegrations(routes);
  const handler = createBrainLinearHandler({ kysely: harness!.db, integrations, providerTimeoutMs, isConnected: async () => true });
  return { integrations, run: (cfg: BrainLinearSourceConfig = config, limits = {}) => harness!.run(handler, cfg, limits) };
}

describe("Linear source", () => {
  it("reads issues, comments and project updates phase by phase and keeps watermarks", async () => {
    harness = await connectorHarness("linear");
    const { integrations, run } = setup({
      "linear.brain_issues": (params) => params.after === null
        ? connection("issues", [issue(1), issue(2, { identifier: "bad key", state: { name: "Done", type: "completed" }, description: null, dueDate: null })], "e1")
        : connection("issues", [issue(3, { archivedAt: "2026-09-05T00:00:00.000Z" })]),
      "linear.brain_comments": () => connection("comments", [{
        id: "c-1", body: "Looks right", url: "https://linear.app/acme/issue/ENG-1#comment-1",
        updatedAt: "2026-09-04T00:00:00.000Z", user: { id: "user-3" }, issue: { id: "issue-1", identifier: "ENG-1", title: "Fix 1" },
      }, { id: "c-2", body: "orphan", updatedAt: "2026-09-04T00:00:00.000Z", user: null, issue: null }, {
        id: "c-3", body: "odd", updatedAt: "2026-09-04T00:00:00.000Z", issue: { id: "issue-9", identifier: "bad", title: "Odd" },
      }]),
      "linear.brain_project_updates": () => connection("projectUpdates", [{
        id: "u-1", body: "On track overall", url: "https://linear.app/acme/project/brain/updates",
        updatedAt: "2026-09-06T00:00:00.000Z", user: { id: "user-1" }, health: "atRisk", project: { id: "p-1", name: "Brain" },
      }, { id: "u-2", body: "No project", updatedAt: "2026-09-06T00:00:00.000Z", health: null, project: null }]),
    });
    const result = await run();
    expect(result).toMatchObject({
      status: "succeeded", caughtUp: true, pages: 4, counts: { written: 7, deleted: 0 }, notices: ["history_window_limited"],
    });
    const odd = await harness.repository.getDocument(connectorScope, connectorDocumentId("linear", harness.externalRef, ["comment", "c-3"]));
    expect(odd!.title).toBe("Comment on issue: Odd");
    expect(integrations.calls.map((call) => [call.action, call.params.after, call.params.updatedSince, call.label])).toEqual([
      ["brain_issues", null, WINDOW_START, "work"], ["brain_issues", "e1", WINDOW_START, "work"],
      ["brain_comments", null, WINDOW_START, "work"], ["brain_project_updates", null, WINDOW_START, "work"],
    ]);
    const ref = harness.externalRef;
    const first = await harness.repository.getDocument(connectorScope, linearIssueDocumentId(ref, "issue-1"));
    expect(first).toMatchObject({ title: "ENG-1: Fix 1", provenance: "linear_issue", permalink: "https://linear.app/acme/issue/ENG-1/fix" });
    expect(first!.body).toBe("Details 1\n\nLinear issue: ENG-1\nState: In Progress\nProject: Brain\nLabels: bug, p1\nDue: 2026-10-10");
    expect(await harness.repository.listDocumentRefs(connectorScope, linearIssueDocumentId(ref, "issue-1"))).toEqual([
      { kind: "assignee", value: "linear:user-2" }, { kind: "author", value: "linear:user-1" }, { kind: "due", value: "2026-10-10" },
      { kind: "handle", value: "ENG-1" }, { kind: "issue", value: "ENG-1" }, { kind: "label", value: "bug" },
      { kind: "label", value: "p1" }, { kind: "status", value: "in_progress" },
    ]);
    const second = await harness.repository.getDocument(connectorScope, linearIssueDocumentId(ref, "issue-2"));
    expect(second).toMatchObject({ title: "Fix 2" });
    expect(await harness.repository.listDocumentRefs(connectorScope, linearIssueDocumentId(ref, "issue-2")))
      .toContainEqual({ kind: "status", value: "done" });
    const comment = connectorDocumentId("linear", ref, ["comment", "c-1"]);
    expect(await harness.repository.getDocument(connectorScope, comment)).toMatchObject({ title: "Comment on ENG-1: Fix 1" });
    expect(await harness.repository.listDocumentRefs(connectorScope, comment)).toEqual([
      { kind: "author", value: "linear:user-3" }, { kind: "issue", value: "ENG-1" },
      { kind: "parent", value: linearIssueDocumentId(ref, "issue-1") },
    ]);
    const orphan = await harness.repository.getDocument(connectorScope, connectorDocumentId("linear", ref, ["comment", "c-2"]));
    expect(orphan).toMatchObject({ title: "Linear comment", body: "orphan\n\nLinear comment on: an issue" });
    const update = connectorDocumentId("linear", ref, ["project_update", "u-1"]);
    expect(await harness.repository.getDocument(connectorScope, update)).toMatchObject({ title: "Project update: Brain" });
    expect(await harness.repository.listDocumentRefs(connectorScope, update)).toContainEqual({ kind: "status", value: "at_risk" });
    const bare = await harness.repository.getDocument(connectorScope, connectorDocumentId("linear", ref, ["project_update", "u-2"]));
    expect(bare).toMatchObject({ title: "Linear project update", body: "No project\n\nLinear project: unknown" });

    integrations.calls.length = 0;
    const again = await run();
    expect(again.notices).toEqual([]);
    expect(integrations.calls.map((call) => call.params.updatedSince)).toEqual([
      "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z", "2026-09-04T00:00:00.000Z", "2026-09-06T00:00:00.000Z",
    ]);
  });

  it("turns archived or trashed items into deletions and starts over when the config changes", async () => {
    harness = await connectorHarness("linear");
    let archived = false;
    const issuesOnly: BrainLinearSourceConfig = { teamKeys: ["ENG", "OPS"], include: { issues: true, comments: false, projectUpdates: false } };
    const { integrations, run } = setup({
      "linear.brain_comments": () => connection("comments", []),
      "linear.brain_issues": () => connection("issues", archived
        ? [issue(1, { trashed: true, updatedAt: "2026-09-08T00:00:00.000Z" })]
        : [issue(1, { description: "x".repeat(70_000), labels: null, state: null, project: null, dueDate: "soon" })]),
    });
    expect((await run(issuesOnly)).notices).toEqual(["history_window_limited", "body_truncated"]);
    const id = linearIssueDocumentId(harness.externalRef, "issue-1");
    expect((await harness.repository.getDocument(connectorScope, id))!.body).toContain("[truncated]\n\nLinear issue: ENG-1");
    archived = true;
    expect((await run(issuesOnly)).counts).toMatchObject({ deleted: 1 });
    expect(await harness.liveIds()).toEqual([]);
    await run({ ...issuesOnly, teamKeys: ["ENG"] });
    expect(integrations.calls.at(-1)!.params).toMatchObject({ teamKeys: ["ENG"], updatedSince: WINDOW_START, first: 100 });
    expect(integrations.calls.at(-1)!.label).toBeUndefined();
    const comments = await run({ teamKeys: ["ENG"], include: { issues: false, comments: true, projectUpdates: false } });
    expect(comments).toMatchObject({ caughtUp: true, counts: { read: 0 } });
    expect(integrations.calls.at(-1)!.action).toBe("brain_comments");
  });

  it("asks for no more issues than the page ref limit can hold", async () => {
    harness = await connectorHarness("linear");
    const labels = { nodes: Array.from({ length: 20 }, (_, index) => ({ name: `label-${index}` })) };
    const { integrations, run } = setup({
      "linear.brain_issues": (params) => connection("issues", Array.from({ length: Number(params.first) },
        (_, index) => issue(1, { id: `issue-${index}`, identifier: `ENG-${index + 1}`, labels }))),
    });
    const issuesOnly = { teamKeys: ["ENG"], include: { issues: true, comments: false, projectUpdates: false } };
    expect(await run(issuesOnly, { refsPerPage: 2_000 })).toMatchObject({ status: "succeeded", counts: { written: 76 } });
    expect(integrations.calls[0]!.params.first).toBe(76);
  });

  it("maps provider outcomes, refused output and timeouts to stable codes", async () => {
    harness = await connectorHarness("linear");
    const cases: [BrainIntegrationCallOutcome, string, number | null][] = [
      [{ status: "not_connected" }, "not_connected", null], [{ status: "unauthorized" }, "auth_failed", null],
      [{ status: "rate_limited", retryAfterSeconds: 99_999 }, "rate_limited", 3_600],
      [{ status: "rate_limited", retryAfterSeconds: Number.NaN }, "rate_limited", 60],
      [{ status: "not_found" }, "remote_not_found", null], [{ status: "invalid" }, "config_invalid", null],
      [{ status: "unavailable" }, "provider_unavailable", null], [ok({ data: { issues: { nodes: "x" } } }), "provider_output_invalid", null],
      [ok({ data: {} }), "provider_output_invalid", null],
      [ok({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } }), "provider_output_invalid", null],
    ];
    for (const [outcome, code, retry] of cases) {
      const { run } = setup({ "linear.brain_issues": () => outcome });
      expect(await run()).toMatchObject({ status: "failed", errorCode: code, retryAfterSeconds: retry });
    }
    const { run } = setup({ "linear.brain_issues": () => new Promise<never>(() => undefined) }, 10); // ignores its signal
    expect((await run()).errorCode).toBe("provider_timeout");
    const thrown = setup({ "linear.brain_issues": () => { throw new TypeError("transport bug"); } });
    expect((await thrown.run()).errorCode).toBe("internal_error");
  });

  it("reports availability from the connection check and offers no option lookups yet", async () => {
    harness = await connectorHarness("linear");
    const handler = createBrainLinearHandler({
      kysely: harness.db, integrations: fakeIntegrations({}), isConnected: async (owner) => owner === "owner_a",
    });
    expect(handler.listOptions).toBeUndefined();
    expect(await handler.availability("owner_a")).toEqual({ available: true });
    expect(await handler.availability("owner_b")).toEqual({ available: false, reason: "not_connected" });
    expect(await handler.createAdapter("owner_b", connectorProject, config)).toEqual({ ok: false, code: "not_connected" });
  });
});
