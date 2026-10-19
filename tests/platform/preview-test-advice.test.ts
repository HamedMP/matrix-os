import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  classifyPreviewTests,
  advisePreviewTests,
} from "../../scripts/ci/preview-test-advice.mjs";
const head = "a".repeat(40);
const main = "b".repeat(40);
const repo = { owner: "example", repo: "matrix-os" };
function fixture(
  files: unknown[] = [{ filename: "shell/app/page.tsx" }],
  base = "main",
) {
  const pr = {
    number: 1,
    state: "open",
    head: { sha: head },
    base: { ref: base },
    labels: [],
    changed_files: files.length,
  };
  const comments: unknown[] = [];
  const github = {
    rest: {
      pulls: {
        get: vi.fn(async () => ({ data: pr })),
        listFiles: vi.fn(async (_args: { page?: number } = {}) => ({
          data: files,
        })),
      },
      repos: {
        getBranch: vi.fn(async () => ({ data: { commit: { sha: main } } })),
        compareCommitsWithBasehead: vi.fn(async () => ({ data: { files } })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: comments })),
        createComment: vi.fn(async (args: { body: string }) => {
          comments.push(args);
        }),
        updateComment: vi.fn(),
      },
    },
  };
  return { github, pr, comments };
}
describe("preview test advice", () => {
  it("avoids paid runtime for docs/tests and recommends exact surfaces without claiming qualification", () => {
    expect(
      classifyPreviewTests([
        { filename: "docs/dev/setup.md" },
        { filename: "tests/kernel/run.test.ts" },
      ]),
    ).toMatchObject({ preview: false, surfaces: [] });
    const advice = classifyPreviewTests([
      { filename: "shell/app/page.tsx" },
      { filename: "packages/brand/src/index.ts" },
    ]);
    expect(advice.preview).toBe(true);
    expect(advice.surfaces).toEqual(
      expect.arrayContaining([
        "Web Desktop",
        "Web Canvas",
        "Web Mobile",
        "Electron Desktop (macOS arm64/x64, Linux x64)",
      ]),
    );
  });
  it("keeps platform API qualification distinct from runtime preview and classifies both rename paths", () => {
    const platform = classifyPreviewTests([
      { filename: "packages/platform/src/routes.ts" },
    ]);
    expect(platform.preview).toBe(false);
    expect(platform.platform).toBe(true);
    const renamed = classifyPreviewTests([
      {
        filename: "shell/routes.ts",
        previous_filename: "packages/platform/routes.ts",
      },
    ]);
    expect(renamed).toMatchObject({ preview: true, platform: true });
    expect(
      classifyPreviewTests([{ filename: "packages/gateway/run.ts" }]).surfaces,
    ).toContain("Runtime/API");
    expect(
      classifyPreviewTests([{ filename: "apps/mobile/App.tsx" }]).surfaces,
    ).toEqual(["Native Mobile (iOS and Android)"]);
  });
  it("fails closed on unknown or incomplete paths", () => {
    expect(
      classifyPreviewTests([{ filename: "mystery/new.runtime" }]).manual,
    ).toBe(true);
    expect(classifyPreviewTests([], false).manual).toBe(true);
    expect(classifyPreviewTests([{}]).manual).toBe(true);
    expect(
      classifyPreviewTests([{ filename: "home/system/prompt.md" }]).preview,
    ).toBe(true);
    expect(
      classifyPreviewTests([{ filename: "pnpm-lock.yaml" }]).surfaces,
    ).toContain("Electron Desktop (macOS arm64/x64, Linux x64)");
  });
  it("includes native and CLI consumers of shared contracts and lockfile changes", () => {
    for (const filename of ["packages/contracts/src/index.ts", "pnpm-lock.yaml"]) {
      const advice = classifyPreviewTests([{ filename }]);
      expect(advice.surfaces).toContain("Native Mobile (iOS and Android)");
      expect(advice.surfaces).toContain("CLI (Linux, macOS and Windows)");
      expect(advice.manual).toBe(true);
    }
    const cli = classifyPreviewTests([{ filename: "packages/sync-client/src/cli.ts" }]);
    expect(cli.surfaces).toContain("CLI (Linux, macOS and Windows)");
    expect(cli.reasons.join(" ")).toContain("separate");
  });
  it("requires compatibility scenarios for gateway changes and infrastructure selection for preview controllers", () => {
    const gateway = classifyPreviewTests([{ filename: "packages/gateway/src/routes.ts" }]);
    expect(gateway.surfaces).toContain("Native Mobile (iOS and Android)");
    expect(gateway.surfaces).toContain("Electron Desktop (macOS arm64/x64, Linux x64)");
    expect(gateway.manual).toBe(true);
    const controller = classifyPreviewTests([{ filename: "scripts/ci/preview-review.mjs" }]);
    expect(controller.preview).toBe(true);
    expect(controller.surfaces).toContain("Preview orchestration");
    expect(controller.reasons.join(" ")).toContain("cleanup");
  });
  it("covers root CLI entrypoints and retains Windows qualification for shared desktop workflows", () => {
    expect(classifyPreviewTests([{ filename: "bin/matrixos.mjs" }]).surfaces).toContain("CLI (Linux, macOS and Windows)");
    const advice = classifyPreviewTests([{ filename: ".github/workflows/desktop-build.yml" }]);
    expect(advice.surfaces).toContain("Windows build (existing protected checks)");
    expect(advice.reasons.join(" ")).toContain("Windows preview installers are unavailable");
  });
  it("does not make a negative preview recommendation when inventory reads fail", async () => {
    const f = fixture();
    f.github.rest.pulls.listFiles.mockRejectedValueOnce(new Error("unavailable"));
    await advisePreviewTests(f.github, repo, 1);
    expect(f.comments[0]).toMatchObject({ body: expect.stringContaining("Preview selection unknown") });
    expect((f.comments[0] as {body: string}).body).not.toContain("No runtime `preview` suggested");
  });
  it("uses cumulative main-to-head changes for stacks and publishes the full exact head", async () => {
    const f = fixture(
      [{ filename: "packages/platform/src/routes.ts" }],
      "codex/parent",
    );
    await advisePreviewTests(f.github, repo, 1);
    expect(f.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({
        basehead: `${main}...${head}`,
        per_page: 100,
        page: 1,
      }),
    );
    expect(f.github.rest.pulls.listFiles).not.toHaveBeenCalled();
    expect(f.comments[0]).toMatchObject({
      body: expect.stringContaining(head),
    });
    expect(f.comments[0]).toMatchObject({
      body: expect.stringContaining("preview-platform"),
    });
  });
  it("paginates ordinary PR files and refuses a truncated compare result", async () => {
    const f = fixture(
      Array.from({ length: 100 }, (_, i) => ({
        filename: `tests/${i}.test.ts`,
      })),
    );
    f.pr.changed_files = 101;
    f.github.rest.pulls.listFiles.mockImplementation(async ({ page }) => ({
      data:
        page === 1
          ? Array.from({ length: 100 }, () => ({ filename: "tests/a.test.ts" }))
          : [{ filename: "desktop/src/main.ts" }],
    }));
    await advisePreviewTests(f.github, repo, 1);
    expect(f.github.rest.pulls.listFiles).toHaveBeenCalledTimes(2);
    expect(f.comments[0]).toMatchObject({
      body: expect.stringContaining("Electron Desktop"),
    });
    const stacked = fixture(
      Array.from({ length: 300 }, () => ({ filename: "docs/a.md" })),
      "stack",
    );
    await advisePreviewTests(stacked.github, repo, 1);
    expect(stacked.comments[0]).toMatchObject({
      body: expect.stringContaining("incomplete"),
    });
  });
  it("does not overwrite queue/platform comments, stale heads, or closed PRs", async () => {
    for (const label of ["preview", "preview-platform"]) {
      const f = fixture();
      f.pr.labels = [{ name: label }] as never[];
      await advisePreviewTests(f.github, repo, 1);
      expect(f.comments).toHaveLength(0);
    }
    const f = fixture();
    f.github.rest.pulls.get
      .mockResolvedValueOnce({ data: structuredClone(f.pr) })
      .mockResolvedValueOnce({ data: { ...f.pr, head: { sha: main } } });
    await advisePreviewTests(f.github, repo, 1);
    expect(f.comments).toHaveLength(0);
    const closed = fixture();
    closed.pr.state = "closed";
    await advisePreviewTests(closed.github, repo, 1);
    expect(closed.comments).toHaveLength(0);
  });
  it("reuses the one bot comment and exposes missing live evidence", async () => {
    const f = fixture();
    f.comments.push({
      id: 9,
      user: { login: "github-actions[bot]" },
      body: "<!-- matrix-preview-review-v1 -->\nold",
    });
    await advisePreviewTests(f.github, repo, 1);
    expect(f.github.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 9,
        body: expect.stringContaining("No live evidence has been inspected"),
      }),
    );
    expect(f.github.rest.issues.createComment).not.toHaveBeenCalled();
  });
  it("uses trusted metadata-only execution with bounded permissions and no deployment authority", () => {
    const wf = YAML.parse(
      readFileSync(".github/workflows/preview-test-advice.yml", "utf8"),
    );
    expect(wf.on.pull_request_target.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
    ]);
    expect(wf.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
    expect(wf.jobs.advise["timeout-minutes"]).toBe(5);
    const checkout = wf.jobs.advise.steps.find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with.ref).toBe("${{ steps.source.outputs.sha }}");
    expect(wf.jobs.advise.if).toContain("github.ref == 'refs/heads/main'");
    expect(wf.jobs.advise.if).toContain(
      "github.event.pull_request.base.ref == 'main'",
    );
    for (const [ref, event, base, allowed] of [
      ["main", "pull_request_target", "main", true],
      ["main", "pull_request_target", "stack", false],
      ["main", "workflow_dispatch", "stack", true],
      ["stack", "workflow_dispatch", "stack", false],
    ]) {
      expect(
        runInNewContext(wf.jobs.advise.if, {
          github: {
            ref: `refs/heads/${ref}`,
            event_name: event,
            event: { pull_request: { base: { ref: base } } },
          },
        }),
      ).toBe(allowed);
    }
    expect(wf.on.workflow_dispatch.inputs.pr.required).toBe(true);
    expect(wf.jobs.advise.steps[0].with.script).toContain("branch: 'main'");
    expect(wf.jobs.advise.steps[0].with.script).toContain("timeout: 15000");
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with["sparse-checkout"]).toContain("scripts/ci/preview-semantic-plan.mjs");
    expect(wf.concurrency.group).toBe("preview-review-scheduler");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    expect(wf.on.workflow_dispatch.inputs.agent_plan.required).toBe(false);
    expect(wf.jobs.advise.steps.at(-1).with.script).toContain("publishAgentTestPlan");
    const source = JSON.stringify(wf);
    expect(source).not.toMatch(/secrets\.|pnpm install|continue-on-error/);
    expect(source).toContain("advisePreviewTests");
  });
});
