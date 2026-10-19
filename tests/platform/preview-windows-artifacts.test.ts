import { describe, expect, it, vi } from "vitest";
import { fixture, head, pr, now } from "./preview-review-fixture";
import { publishReviewComments } from "../../scripts/ci/preview-review-report.mjs";

function desktopPreview() {
  const f = fixture(), row = f.reserve();
  row.payload.desktop = true;
  f.web(row);
  f.machine();
  const run = f.web(row, 102, {
    path: ".github/workflows/preview-desktop.yml",
    display_title: `preview-desktop-v1 pr=1 head=${head} lease=${row.id}`,
  });
  const prefix = `preview-desktop-pr1-${head}-lease${row.id}`;
  const artifacts = ["source", "macos-arm64", "macos-x64", "linux-x64", "windows-x64"].map((suffix, i) => ({
    id: 1000 + i, name: `${prefix}-${suffix}`, expired: false,
    expires_at: "2026-10-22T08:00:00Z",
  }));
  f.github.rest.actions.listWorkflowRunArtifacts = vi.fn(async () => ({ data: { artifacts } }));
  return { ...f, row, run, artifacts };
}

describe("four-platform current-head preview downloads", () => {
  it("requires and publishes all four installers, clearly labeling unsigned Windows", async () => {
    const f = desktopPreview();
    await f.reconcile();
    const body = f.comments.get(1).body;
    expect(body).toContain("Ready for review");
    expect(body).toContain("Windows x64 · unsigned preview");
    for (const a of f.artifacts.slice(1)) expect(body).toContain(`/artifacts/${a.id}`);
    expect(body).toContain("2026-10-22T08:00:00Z");
    expect(body).toContain("How to test");
    expect(body).toContain("pr-1");
    expect(body).not.toContain("Windows branch installers are not published");
  });

  it.each(["missing", "expired-flag", "expired-time", "wrong-head", "wrong-lease"])(
    "never reports desktop ready with a %s Windows artifact", async (failure) => {
      const f = desktopPreview(), a = f.artifacts.at(-1)!;
      if (failure === "missing") f.artifacts.pop();
      if (failure === "expired-flag") a.expired = true;
      if (failure === "expired-time") a.expires_at = new Date(now).toISOString();
      if (failure === "wrong-head") a.name = a.name.replace(head, "c".repeat(40));
      if (failure === "wrong-lease") a.name = a.name.replace("lease1", "lease2");
      await f.reconcile();
      expect(f.comments.get(1).body).toContain("Desktop downloads unavailable/expired");
      expect(f.comments.get(1).body).not.toContain("Ready for review");
      expect(f.comments.get(1).body).not.toContain(`/artifacts/${a.id}`);
    },
  );

  it("removes all download links when source proof expires", async () => {
    const f = desktopPreview();
    await f.reconcile();
    f.artifacts[0].expired = true;
    await f.reconcile();
    expect(f.comments.size).toBe(1);
    expect(f.comments.get(1).body).not.toContain("/artifacts/");
    expect(f.comments.get(1).body).toContain("unavailable/expired");
  });

  it("removes previous-head links immediately on a new commit", async () => {
    // Retiring the old lease must not publish its source decision for the new head.
    const p = pr(1), other = fixture([p]), row = other.reserve();
    row.payload.desktop = false;
    other.web(row);
    other.machine();
    p.head.sha = "c".repeat(40);
    await publishReviewComments({
      github: other.github, repo: { owner: "HamedMP", repo: "matrix-os" },
      prs: [p], leases: [row], machines: other.machines, retiring: [],
      waiting: [], active: [], ownedRuns: async () => [], status: async () => {},
      now, occupied: 1,
    });
    expect(other.comments.get(1).body).not.toContain("[Open preview]");
    expect(other.comments.get(1).body).not.toContain("inputs unchanged");
    expect(other.comments.get(1).body).not.toContain("/artifacts/");
  });

  it("explicitly reports unchanged desktop inputs instead of pending downloads", async () => {
    const f = fixture(), row = f.reserve();
    f.web(row);
    f.machine();
    await f.reconcile();
    const body = f.comments.get(1).body;
    expect(body).toContain("Desktop inputs unchanged; no new installer was built");
    expect(body).not.toContain("Pending, or no desktop build required");
    expect(body).not.toContain("/artifacts/");
    expect(body).toContain("existing desktop app");
  });
});
