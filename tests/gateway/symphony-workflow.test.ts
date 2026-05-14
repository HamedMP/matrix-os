import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../../packages/gateway/src/state-ops.js";
import { composeSymphonyPrompt, loadWorkflowContract, SymphonyWorkflowError } from "../../packages/gateway/src/symphony/prompt.js";

describe("Symphony workflow", () => {
  let homePath: string;
  let repoPath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-symphony-workflow-"));
    repoPath = join(homePath, "projects", "matrix-os", "repo");
    await mkdir(repoPath, { recursive: true });
    await atomicWriteJson(join(homePath, "projects", "matrix-os", "config.json"), {
      id: "proj_matrix",
      slug: "matrix-os",
      name: "Matrix OS",
      localPath: repoPath,
      addedAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      ownerScope: { type: "user", id: "user_123" },
    });
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("loads workflow policy inside the selected Matrix project", async () => {
    await writeFile(join(repoPath, "WORKFLOW.md"), "Run tests before handoff.");

    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os" })).resolves.toMatchObject({
      projectSlug: "matrix-os",
      body: "Run tests before handoff.",
    });
  });

  it("creates a default workflow contract in registered projects when none exists", async () => {
    const workflow = await loadWorkflowContract({ homePath, projectSlug: "matrix-os" });

    expect(workflow).toMatchObject({
      projectSlug: "matrix-os",
      path: join(repoPath, "WORKFLOW.md"),
    });
    expect(workflow.body).toContain("Matrix Symphony workflow");
    await expect(readFile(join(repoPath, "WORKFLOW.md"), "utf8")).resolves.toContain("Matrix Symphony workflow");
  });

  it("rejects workflow paths outside the Matrix project", async () => {
    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os", workflowPath: "../secret.md" }))
      .rejects.toBeInstanceOf(SymphonyWorkflowError);
  });

  it("reports a clear setup error when a custom workflow path is missing", async () => {
    await expect(loadWorkflowContract({ homePath, projectSlug: "matrix-os", workflowPath: "docs/WORKFLOW.md" }))
      .rejects.toMatchObject({ code: "workflow_missing" });
  });

  it("composes prompt from workflow and ticket context without secrets", () => {
    const prompt = composeSymphonyPrompt({
      workflow: {
        projectSlug: "matrix-os",
        path: "/repo/WORKFLOW.md",
        body: "Follow WORKFLOW.md.",
        lastLoadedAt: "2026-05-13T00:00:00.000Z",
      },
      ticket: {
        externalId: "issue_1",
        identifier: "MAT-1",
        title: "Build Matrix Symphony",
        stateName: "Todo",
        assigneeName: "Hamed",
        labels: ["symphony"],
      },
      attempt: 1,
    });

    expect(prompt).toContain("Follow WORKFLOW.md.");
    expect(prompt).toContain("MAT-1");
    expect(prompt).toContain("Build Matrix Symphony");
    expect(prompt).not.toContain("lin_api");
  });
});
