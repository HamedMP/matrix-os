import { describe, expect, it } from "vitest";
import { fixture, pr, head, now, pin, repo } from "./preview-review-fixture";
import { planQueue } from "../../scripts/ci/preview-review-model.mjs";
import { verifyPreviewRequest } from "../../scripts/ci/preview-review-request.mjs";
const comment = { id: 1, body: "<!-- matrix-preview-review-v1 -->\n**PR preview: Queued**", user: { login: "github-actions[bot]" } };

describe("preview queue regression boundaries", () => {
  it.each(["withdrawn", "closed"])("retains advice/planning comments in snapshot and REST %s recovery", async (mode) => {
    for (const title of ["PR test advice (advisory only)", "PR test planning"]) {
      for (const older of [false, true]) {
        const p = pr(1, mode === "closed" ? { state: "closed" } : { labels: [] });
        const f = fixture([p]);
        const body = `<!-- matrix-preview-review-v1 -->\n**${title}**\nSource: \`${head}\`\nSuggested: preview; surfaces: Web Canvas`;
        const row = { ...comment, body };
        f.comments.set(1, row);
        if (older) {
          const graphql = f.github.graphql;
          f.github.graphql = async (...args: any[]) => {
            const data = await graphql(...args);
            if (args[1].number) {
              data.repository.pullRequest.comments.nodes = [];
              data.repository.pullRequest.comments.pageInfo.hasPreviousPage = true;
            }
            return data;
          };
          f.github.rest.issues.listComments = async () => ({data: [row]});
        }
        await f.reconcile({ requestedPr: 1 });
        expect(f.comments.get(1).body).toBe(body);
        expect(f.dispatches).toEqual([]);
      }
    }
  });
  it("adopts a verified existing owned machine even when all sixteen slots are occupied", async () => {
    const f = fixture([pr(1), pr(20)]);
    for (let n = 1; n <= 16; n++) f.machine(n);
    await f.reconcile();
    expect(f.dispatches.map((d: any) => d.inputs.pr)).toEqual(["1"]);
    expect(f.leases).toHaveLength(1);
    expect(f.comments.get(20).body).toContain("Queued");
  });
  it("adoption does not consume the remaining free slot", async () => {
    const f = fixture([pr(1), pr(20), pr(21)]);
    for (let n = 1; n <= 15; n++) f.machine(n);
    await f.reconcile();
    expect(f.dispatches.map((d: any) => d.inputs.pr)).toEqual(["1", "20"]);
    expect(f.comments.get(21).body).toContain("Queued");
  });
  it("does not grant capacity-free adoption to foreign, ambiguous or expired machines", () => {
    for (const kind of ["foreign", "ambiguous", "expired", "unknown-owner"]) {
      const f = fixture();
      for (let n = 1; n <= 16; n++) f.machine(n);
      if (kind === "foreign") f.machines[0].clerkUserId = "user_other";
      if (kind === "ambiguous") f.machine(1);
      if (kind === "expired") f.machines[0].provisionedAt = "2026-10-10T09:00:00Z";
      const plan = planQueue({ requests: [pr(1)], reservations: [], machines: f.machines, owner: kind === "unknown-owner" ? undefined : "user_team", now });
      expect(plan.admit).toEqual([]);
    }
  });
  it("persists cleanup before cancellation and finishes after the label is re-added", async () => {
    const p = pr(1, { labels: [] }), f = fixture([p]);
    const row = f.reserve();
    f.web(row, 101, { status: "in_progress", conclusion: null });
    f.machine();
    const cancel = f.github.rest.actions.cancelWorkflowRun;
    f.github.rest.actions.cancelWorkflowRun = async (args: any) => {
      expect(row.description).toMatch(/^Cleanup started:/);
      return cancel(args);
    };
    await f.reconcile();
    p.labels = [{ name: "preview" }];
    f.runs[0].status = "completed";
    await f.reconcile();
    expect(row.state).toBe("inactive");
    expect(f.machines).toHaveLength(0);
  });
  it("persists cleanup before deleting and retains it through provider proof failure", async () => {
    const p = pr(1, { labels: [] }), f = fixture([p]), row = f.reserve();
    f.web(row);
    f.machine();
    f.platform.remove = async () => {
      expect(row.description).toMatch(/^Cleanup started:/);
      throw new Error("temporary provider outage");
    };
    await f.reconcile();
    expect(row.description).toMatch(/^Cleanup started:/);
    p.labels = [{ name: "preview" }];
    await f.reconcile();
    expect(f.dispatches).toEqual([]);
    expect(f.comments.get(1).body).not.toContain("[Open preview]");
  });
  it("refuses privileged builds when cleanup is already persisted despite a live label", async () => {
    for (const state of ["pending", "in_progress", "success"]) {
      const description = "Cleanup started: Waiting for physical preview cleanup confirmation";
      const f = fixture(), row = f.reserve();
      f.github.rest.repos.getDeployment = async () => ({ data: row });
      f.github.rest.repos.listDeploymentStatuses = async () => ({ data: [{ state, description }] });
      await expect(verifyPreviewRequest(f.github, repo, { pr: "1", lease: "1", head, controllerSha: pin, now })).rejects.toThrow();
    }
  });
  it.each(["withdrawn", "closed"])("updates an existing queued comment after %s via requestedPr", async (mode) => {
    const p = pr(1, mode === "closed" ? { state: "closed" } : { labels: [] }), f = fixture([p]);
    f.comments.set(1, { ...comment });
    await f.reconcile({ requestedPr: 1 });
    expect(f.comments.get(1).body).toContain("PR preview: Stopped");
    expect(f.dispatches).toEqual([]);
  });
  it("recovers withdrawn and closed queue comments without creating unrelated comments", async () => {
    const f = fixture([pr(1, { labels: [] }), pr(2, { state: "closed" }), pr(3, { labels: [] }), pr(4, { state: "closed" })]);
    f.comments.set(1, { ...comment });
    f.comments.set(2, { ...comment, id: 2 });
    // Select the first bounded closed-recovery page.
    await f.reconcile({ now: now - now % (50 * 300000) });
    expect(f.comments.get(1).body).toContain("PR preview: Stopped");
    expect(f.comments.get(2).body).toContain("PR preview: Stopped");
    expect(f.comments.has(3)).toBe(false);
    expect(f.comments.has(4)).toBe(false);
  });
  it("bounds withdrawal recovery and lets a requested PR bypass the rotating budget", async () => {
    const f = fixture(Array.from({ length: 80 }, (_, n) => pr(n + 1, { labels: [] })));
    for (let n = 1; n <= 80; n++) f.comments.set(n, { ...comment, id: n });
    let reads = 0;
    const graphql = f.github.graphql;
    f.github.graphql = (...args: any[]) => { if (args[1].number) reads++; return graphql(...args); };
    await f.reconcile({ requestedPr: 80 });
    expect(f.comments.get(80).body).toContain("PR preview: Stopped");
    expect(reads).toBeLessThanOrEqual(25);
  });
  it("finds an older queued bot comment without creating comments when history has no match", async () => {
    for (const found of [true, false]) {
      const f = fixture([pr(1, { labels: [] })]);
      const graphql = f.github.graphql;
      f.github.graphql = async (...args: any[]) => {
        const data = await graphql(...args);
        if (args[1].number) data.repository.pullRequest.comments.pageInfo.hasPreviousPage = true;
        return data;
      };
      f.github.rest.issues.listComments = async () => ({ data: found ? [comment] : [{ ...comment, user: { login: "other" } }] });
      let creates = 0;
      f.github.rest.issues.createComment = async () => { creates++; return { data: {} }; };
      await f.reconcile({ requestedPr: 1 });
      expect(creates).toBe(0);
      if (found) expect(f.comments.get(1).body).toContain("PR preview: Stopped");
      else expect(f.comments.has(1)).toBe(false);
    }
  });
  it("does not overwrite a comment when the withdrawn label returns during publication", async () => {
    const f = fixture([pr(1, { labels: [] })]);
    f.comments.set(1, { ...comment });
    const graphql = f.github.graphql;
    f.github.graphql = async (...args: any[]) => {
      const data = await graphql(...args);
      if (args[1].number) data.repository.pullRequest.labels.nodes = [{ name: "preview" }];
      return data;
    };
    await f.reconcile({ requestedPr: 1 });
    expect(f.comments.get(1).body).toBe(comment.body);
  });
  it("qualifies the platform when a platform file is renamed away", async () => {
    const f = fixture();
    f.github.rest.pulls.listFiles = async () => ({ data: [{ filename: "packages/gateway/moved.ts", previous_filename: "packages/platform/src/moved.ts" }] });
    await f.reconcile();
    expect(f.leases[0].payload.platform).toBe(true);
    expect(f.comments.get(1).body).toContain("Platform changes require");
  });
});
