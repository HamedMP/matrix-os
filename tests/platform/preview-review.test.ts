import { describe, it, expect } from "vitest";
import {
  planQueue,
  needsDesktop,
  renderReview,
} from "../../scripts/ci/preview-review-model.mjs";
import {
  originReadSnapshot,
  platformClient,
} from "../../scripts/ci/preview-review-api.mjs";
import { verifyPreviewRequest } from "../../scripts/ci/preview-review-request.mjs";

const head = "a".repeat(40),
  pin = "b".repeat(40),
  now = Date.parse("2026-10-19T10:00:00Z");
const pr = (number: number, extra = {}) => ({
  number,
  head: { sha: head, repo: { full_name: "HamedMP/matrix-os" } },
  state: "open",
  user: { login: "engineer" },
  title: "Change",
  labels: [{ name: "preview" }],
  ...extra,
});
const reservation = (number: number, extra = {}) => ({
  id: number,
  sha: head,
  task: "matrix-preview-v1",
  environment: `review-pr-${number}`,
  creator: { login: "github-actions[bot]", type: "Bot" },
  created_at: "2026-10-19T09:00:00Z",
  payload: {
    schema: "matrix-preview-v1",
    pr: number,
    head,
    controllerSha: pin,
    owner: "user_team",
    desktop: true,
    expiresAt: "2026-10-22T09:00:00Z",
  },
  ...extra,
});
const machine = (number: number, extra = {}) => ({
  machineId: `machine-${number}`,
  handle: `pr-${number}`,
  runtimeSlot: `pr-${number}`,
  provisioningClass: "preview",
  clerkUserId: "user_team",
  status: "running",
  deletedAt: null,
  ...extra,
});

describe("preview admission and truthful reviewer status", () => {
  it("holds unknown legacy tombstones and never treats them as backing a new reservation", () => {
    for (const proof of [undefined, false]) {
      const result = planQueue({ requests: [pr(2)], reservations: [reservation(1)],
        machines: [machine(1, { status: "deleted", deletedAt: "2026-10-19", previewDeletionConfirmed: proof })], now });
      expect(result.occupied).toBe(2);
      expect(result.admit).toEqual([]);
      expect(result.waiting.map((p: any) => p.number)).toEqual([2]);
      expect(result.cleanupPending).toBe(true);
    }
    const released = planQueue({ requests: [pr(2)], reservations: [], machines: [machine(1, {
      status: "deleted", deletedAt: "2026-10-19", previewDeletionConfirmed: true,
    })], now });
    expect(released.occupied).toBe(0);
    expect(released.admit.map((p: any) => p.number)).toEqual([2]);
  });
  it("holds all new allocation while an unreserved deleted legacy machine lacks physical proof", () => {
    const result = planQueue({ requests: [pr(17)], reservations: [], machines: [machine(16, {
      status: "deleted", deletedAt: "2026-10-19", previewDeletionConfirmed: false,
    })], now });
    expect(result.occupied).toBe(1);
    expect(result.admit).toEqual([]);
    expect(result.waiting.map((p: any) => p.number)).toEqual([17]);
  });
  it("holds exactly sixteen slots including legacy machines and pending reservations", () => {
    const result = planQueue({
      requests: [pr(21), pr(22), pr(23)],
      reservations: [reservation(20)],
      machines: Array.from({ length: 14 }, (_, i) => machine(i + 1)),
      now,
    });
    expect(result.admit.map((p: any) => p.number)).toEqual([21]);
    expect(result.waiting.map((p: any) => p.number)).toEqual([22, 23]);
    expect(result.occupied).toBe(15);
  });
  it("counts a reserved physical machine only once and excludes private/customer machines", () => {
    const result = planQueue({
      requests: [pr(1), pr(2)],
      reservations: [reservation(1)],
      machines: [
        machine(1),
        machine(8, { provisioningClass: "private-preview" }),
        machine(9, { provisioningClass: "customer" }),
      ],
      now,
    });
    expect(result.occupied).toBe(1);
    expect(result.admit.map((p: any) => p.number)).toEqual([2]);
  });
  it("counts a different-owner same-handle runtime separately from a pending lease", () => {
    const result = planQueue({
      requests: [],
      reservations: [reservation(1)],
      machines: [machine(1, { clerkUserId: "user_other" })],
      now,
    });
    expect(result.occupied).toBe(2);
  });
  it("keeps expired and stale reservations occupied until confirmed cleanup", () => {
    const result = planQueue({
      requests: [pr(1, { head: { sha: "c".repeat(40) } })],
      reservations: [
        reservation(1, {
          payload: {
            ...reservation(1).payload,
            expiresAt: "2026-10-18T09:00:00Z",
          },
        }),
      ],
      machines: [],
      now,
    });
    expect(result.cleanup.map((r: any) => r.id)).toEqual([1]);
    expect(result.admit).toEqual([]);
    expect(result.occupied).toBe(1);
  });
  it("requires merge/close or label removal cleanup, and never admits forks", () => {
    const result = planQueue({
      requests: [
        pr(1, { state: "closed" }),
        pr(2, { labels: [] }),
        pr(3, { head: { sha: head, repo: { full_name: "evil/fork" } } }),
      ],
      reservations: [reservation(1), reservation(2)],
      machines: [],
      now,
    });
    expect(result.cleanup).toHaveLength(2);
    expect(result.admit).toEqual([]);
  });
  it("builds desktop for shared inputs and lock changes, not gateway-only changes", () => {
    for (const path of [
      "desktop/src/main/index.ts",
      "packages/ui/src/a.tsx",
      "packages/brand/src/index.ts",
      "packages/contracts/src/index.ts",
      "packages/sync-client/src/index.ts",
      "shell/public/icons/a.svg",
      "pnpm-lock.yaml",
      "scripts/release/build-source.mjs",
      "scripts/release/desktop-update-fixture-server.mjs",
    ])
      expect(needsDesktop([path])).toBe(true);
    expect(needsDesktop(["packages/gateway/src/server.ts"])).toBe(false);
  });
  it("renders exact head, waiting authors and pending state without stale download links", () => {
    const result = renderReview({
      pr: pr(1, { title: "bad | title\nrow" }),
      status: "Queued",
      queue: [pr(2, { user: { login: "other" } })],
      active: [{ pr: 3, author: "reviewer" }],
      head,
      expiresAt: null,
      web: null,
      artifacts: [],
    });
    expect(result).toContain(head);
    expect(result).toContain("@other");
    expect(result).toContain("#2");
    expect(result).toContain("Queued");
    expect(result).toContain("16");
    expect(result).not.toContain("/vm/pr-1");
    expect(result).not.toContain("\nrow");
  });
  it("verifies immutable reservation, current PR and TTL before privileged builds", async () => {
    const github = {
      rest: {
        repos: {
          getDeployment: async () => ({ data: reservation(1) }),
          listDeploymentStatuses: async () => ({
            data: [{ state: "in_progress" }],
          }),
        },
        pulls: { get: async () => ({ data: pr(1) }) },
      },
    };
    await expect(
      verifyPreviewRequest(
        github,
        { owner: "HamedMP", repo: "matrix-os" },
        { pr: "1", head, lease: "1", controllerSha: pin, now },
      ),
    ).resolves.toMatchObject({ pr: 1, head, lease: 1 });
    github.rest.pulls.get = async () => ({
      data: pr(1, {
        head: { sha: "c".repeat(40), repo: { full_name: "HamedMP/matrix-os" } },
      }),
    });
    await expect(
      verifyPreviewRequest(
        github,
        { owner: "HamedMP", repo: "matrix-os" },
        { pr: "1", head, lease: "1", controllerSha: pin, now },
      ),
    ).rejects.toThrow();
  });
  it("rejects user-created leases and released or expired reservations", async () => {
    for (const change of [
      { creator: { login: "attacker", type: "User" } },
      {
        payload: {
          ...reservation(1).payload,
          expiresAt: "2026-10-18T09:00:00Z",
        },
      },
    ]) {
      const github = {
        rest: {
          repos: {
            getDeployment: async () => ({ data: reservation(1, change) }),
            listDeploymentStatuses: async () => ({
              data: [{ state: "pending" }],
            }),
          },
          pulls: { get: async () => ({ data: pr(1) }) },
        },
      };
      await expect(
        verifyPreviewRequest(
          github,
          { owner: "HamedMP", repo: "matrix-os" },
          { pr: "1", head, lease: "1", controllerSha: pin, now },
        ),
      ).rejects.toThrow();
    }
  });
});

describe("bounded operator and proof reads", () => {
  it("merges tombstone capacity with fresh runtime health rather than relying on active fleet alone", async () => {
    const calls: string[] = [];
    const client = platformClient({ token: "operator", fetchImpl: async (url: string) => {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ machines: new URL(url).pathname === "/vps/fleet"
        ? [machine(1, { healthy: true, runtimeVersion: "exact" })]
        : [machine(1), machine(2, { status: "deleted", deletedAt: "2026-10-19", previewDeletionConfirmed: false })], truncated: false }));
    } });
    const inventory = await client.fleet();
    expect(calls).toEqual(["/vps/fleet", "/vps/preview-capacity"]);
    expect(inventory).toEqual([expect.objectContaining({ machineId: "machine-1", healthy: true, runtimeVersion: "exact" }),
      expect.objectContaining({ machineId: "machine-2", status: "deleted", previewDeletionConfirmed: false })]);
  });
  it("uses explicit physical proof, not a deleted DB status", async () => {
    const client = platformClient({
      token: "operator",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "deleted",
            previewDeletionConfirmed: false,
          }),
        ),
    });
    expect(await client.deletionConfirmed(1, "user_team")).toBe(false);
  });
  it("shares proof reads only within a single snapshot", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return { data: {} };
    };
    const github = {
      rest: {
        repos: { getBranch: read, compareCommitsWithBasehead: read },
        git: { getCommit: read },
      },
    };
    const snap = originReadSnapshot(github);
    await snap.rest.repos.getBranch({ branch: "main" });
    await snap.rest.repos.getBranch({ branch: "main" });
    expect(calls).toBe(1);
    await snap.rest.git.getCommit({ branch: "main" });
    expect(calls).toBe(2);
    await originReadSnapshot(github).rest.repos.getBranch({ branch: "main" });
    expect(calls).toBe(3);
  });
});
