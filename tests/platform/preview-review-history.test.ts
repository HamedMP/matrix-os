import { describe, expect, it } from "vitest";
import { loadPreviewHistory } from "../../scripts/ci/preview-review-history.mjs";
const now = Date.parse("2026-10-19T12:00:00Z");
function row(id: number, state = "inactive", extra: any = {}) {
  return {
    id,
    node_id: String(id),
    task: "matrix-preview-v1",
    state,
    creator: { login: "github-actions[bot]", type: "Bot" },
    environment: `review-pr-${id}`,
    sha: "a".repeat(40),
    created_at: "2026-10-01T12:00:00Z",
    payload: {
      schema: "matrix-preview-v1",
      pr: id,
      head: "a".repeat(40),
      controllerSha: "b".repeat(40),
      expiresAt: "2026-10-22T12:00:00Z",
    },
    ...extra,
  };
}
function fixture(rows: any[]) {
  const deleted: number[] = [],
    calls: any[] = [];
  let unavailable = false,
    deletionFails = false;
  const github: any = {
    graphql: async (_: string, args: any) => ({
      nodes: args.ids.map((id: string) => {
        const r = rows.find((r) => r.node_id === id);
        return unavailable
          ? null
          : {
              id,
              latestStatus: { state: r.state.toUpperCase(), description: "" },
            };
      }),
    }),
    rest: {
      repos: {
        listDeployments: async (args: any) => {
          calls.push(args);
          return { data: rows.slice((args.page - 1) * 100, args.page * 100) };
        },
        deleteDeployment: async ({ deployment_id }: any) => {
          if (deletionFails) throw new Error("transport unavailable");
          deleted.push(deployment_id);
          rows.splice(
            rows.findIndex((r) => r.id === deployment_id),
            1,
          );
        },
      },
    },
  };
  return {
    github,
    deleted,
    calls,
    setUnavailable: () => (unavailable = true),
    setDeletionFails: () => (deletionFails = true),
  };
}
const repo = { owner: "HamedMP", repo: "matrix-os" };
describe("bounded preview deployment history", () => {
  it("retains all active states while pruning only old inactive reservations", async () => {
    const f = fixture(
      ["pending", "in_progress", "success", "failure", "error", "inactive"].map(
        (s, i) => row(i + 1, s),
      ),
    );
    const result = await loadPreviewHistory({ github: f.github, repo, now });
    expect(result.complete).toBe(true);
    expect(result.leases.map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(f.deleted).toEqual([6]);
    expect(f.calls[0]).toMatchObject({
      task: "matrix-preview-v1",
      per_page: 100,
      page: 1,
    });
  });
  it("preserves recent, foreign and non-task deployments", async () => {
    const f = fixture([
      row(1, "inactive", { created_at: "2026-10-18T00:00:00Z" }),
      row(2, "inactive", { creator: { login: "other-bot", type: "Bot" } }),
      row(3, "inactive", { task: "another-task" }),
    ]);
    expect(
      (await loadPreviewHistory({ github: f.github, repo, now })).leases,
    ).toEqual([]);
    expect(f.deleted).toEqual([]);
  });
  it("does not skip active rows by deleting while offset pages are loading", async () => {
    const f = fixture([
      ...Array.from({ length: 100 }, (_, i) => row(i + 1)),
      row(101, "success"),
    ]);
    const result = await loadPreviewHistory({ github: f.github, repo, now });
    expect(result.leases.map((r: any) => r.id)).toEqual([101]);
    expect(f.deleted).toHaveLength(100);
  });
  it("returns known active rows with incomplete admission authority at the cap", async () => {
    const f = fixture(
      Array.from({ length: 5001 }, (_, i) =>
        row(i + 1, i === 4999 ? "success" : "inactive"),
      ),
    );
    const result = await loadPreviewHistory({ github: f.github, repo, now });
    expect(result.complete).toBe(false);
    expect(result.leases.map((r: any) => r.id)).toEqual([5000]);
    expect(f.calls).toHaveLength(50);
    expect(f.deleted).toHaveLength(100);
    const next = await loadPreviewHistory({ github: f.github, repo, now });
    expect(next.complete).toBe(true);
    expect(next.leases.map((r: any) => r.id)).toEqual([5000]);
  });
  it("fails closed before pruning on invalid owned history", async () => {
    const f = fixture([row(1), row(2, "success", { environment: "wrong" })]);
    await expect(
      loadPreviewHistory({ github: f.github, repo, now }),
    ).rejects.toThrow("Invalid owned");
    expect(f.deleted).toEqual([]);
  });
  it("fails closed when a status cannot be obtained", async () => {
    const f = fixture([row(1)]);
    f.setUnavailable();
    await expect(
      loadPreviewHistory({ github: f.github, repo, now }),
    ).rejects.toThrow("status unavailable");
    expect(f.deleted).toEqual([]);
  });
  it("holds admission on prune errors without losing known cleanup leases", async () => {
    const f = fixture([row(1), row(2, "error")]);
    f.setDeletionFails();
    const result = await loadPreviewHistory({ github: f.github, repo, now });
    expect(result.complete).toBe(false);
    expect(result.leases.map((r: any) => r.id)).toEqual([2]);
  });
});
