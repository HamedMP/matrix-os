import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const workflow = (name: string) =>
  YAML.parse(readFileSync(resolve(".github/workflows", name), "utf8"));
const sha = "a".repeat(40);
const step = (job: any, name: string) =>
  job.steps.find((value: any) => value.name === name);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function resolveSource(sourceRef: string, actualSha = sha) {
  const source = workflow("desktop-build.yml").jobs.source;
  const outputs: Record<string, string> = {};
  const getCommit = vi.fn(async () => ({ data: { sha: actualSha } }));
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
  };
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    step(source, "Resolve immutable desktop source").with.script,
  )(
    { rest: { repos: { getCommit } } },
    { repo: { owner: "HamedMP", repo: "matrix-os" }, sha },
    core,
    { env: { SOURCE_REF: sourceRef } },
  );
  return { outputs, getCommit };
}

describe("source-bound preview desktop builds", () => {
  it("keeps existing callers on their event commit and resolves explicit immutable heads", async () => {
    for (const ref of ["", sha]) {
      const { outputs, getCommit } = await resolveSource(ref);
      expect(outputs.source_sha).toBe(sha);
      expect(getCommit).toHaveBeenCalledWith({
        owner: "HamedMP",
        repo: "matrix-os",
        ref: sha,
        request: { timeout: 10000 },
      });
    }
  });

  it.each([
    "main",
    "refs/pull/1/head",
    "a".repeat(39),
    "a".repeat(41),
    "A".repeat(40),
    "$(touch /tmp/injected)",
  ])("rejects mutable or malformed source %s", async (sourceRef) => {
    await expect(resolveSource(sourceRef)).rejects.toThrow("immutable");
  });

  it("rejects a source response for a different commit", async () => {
    await expect(resolveSource(sha, "b".repeat(40))).rejects.toThrow(
      "identity",
    );
  });

  it.each([
    {
      pin: "",
      eventName: "workflow_dispatch",
      ref: `refs/heads/ci-execution/${sha}`,
    },
    { pin: "main", eventName: "workflow_dispatch", ref: "refs/heads/main" },
    {
      pin: sha,
      eventName: "pull_request",
      ref: `refs/heads/ci-execution/${sha}`,
    },
    { pin: sha, eventName: "workflow_dispatch", ref: "refs/heads/main" },
    {
      pin: sha,
      eventName: "workflow_dispatch",
      ref: `refs/heads/ci-execution/${"b".repeat(40)}`,
    },
  ])(
    "rejects an unreviewed execution configuration before checking out verifiers: %j",
    async ({ pin, eventName, ref }) => {
      const request = workflow("preview-desktop.yml").jobs.request;
      const config = step(request, "Require reviewed controller configuration");
      await expect(
        new AsyncFunction("context", "process", config.with.script)(
          { eventName, ref },
          { env: { MATRIX_CI_CONTROLLER_SHA: pin } },
        ),
      ).rejects.toThrow("Reviewed isolated");
      expect(request.steps.indexOf(config)).toBeLessThan(
        request.steps.findIndex((value: any) =>
          value.uses?.startsWith("actions/checkout@"),
        ),
      );
    },
  );

  it("proves every platform checkout before dependency installation and packaging", () => {
    const build = workflow("desktop-build.yml");
    expect(build.on.workflow_call.inputs.source_ref).toMatchObject({
      required: false,
      type: "string",
      default: "",
    });
    for (const platform of ["mac", "linux", "windows"]) {
      const job = build.jobs[platform];
      expect(job.needs).toBe("source");
      const checkout = job.steps.find((value: any) =>
        value.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.with.ref).toBe("${{ needs.source.outputs.source_sha }}");
      expect(checkout.with["persist-credentials"]).toBe(false);
      const proof = step(job, "Verify desktop source checkout");
      expect(proof.env.DESKTOP_SOURCE_SHA).toBe(
        "${{ needs.source.outputs.source_sha }}",
      );
      expect(proof.run).toContain("execFileSync('git', ['rev-parse', 'HEAD']");
      expect(job.steps.indexOf(proof)).toBeLessThan(
        job.steps.indexOf(step(job, "Install dependencies")),
      );
      const buildStep = step(job, "Build desktop app");
      expect(buildStep.env.MATRIX_DESKTOP_BUILD_SOURCE_SHA).toBe(
        "${{ needs.source.outputs.source_sha }}",
      );
      expect(buildStep.env).not.toHaveProperty("GITHUB_SHA");
      expect(buildStep.run).toContain("spawnSync('bun', ['--cwd', 'desktop', 'run', 'build']");
      expect(buildStep.run).toContain("GITHUB_SHA: process.env.MATRIX_DESKTOP_BUILD_SOURCE_SHA");
    }
    expect(
      step(build.jobs.source, "Upload desktop source metadata").with,
    ).toMatchObject({
      name: "${{ inputs.artifact_prefix }}-source",
      "retention-days": "${{ inputs.retention_days }}",
      "if-no-files-found": "error",
    });
    for (const gate of [
      "Prepare mac signing environment",
      "Validate Apple notarization secrets",
      "Smoke test macOS DMG mount and Launch smoke test macOS app",
    ]) {
      expect(step(build.jobs.mac, gate), gate).toBeDefined();
    }
    expect(
      step(
        build.jobs.windows,
        "Verify Windows artifacts and Authenticode signatures",
      ),
    ).toBeDefined();
  });

  it("only dispatches through a verified controller and an active source-bound reservation", () => {
    const preview = workflow("preview-desktop.yml");
    expect(Object.keys(preview.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(preview.on.workflow_dispatch.inputs)).toEqual([
      "pr",
      "head",
      "lease",
    ]);
    expect(preview["run-name"]).toBe(
      "preview-desktop-v1 pr=${{ inputs.pr }} head=${{ inputs.head }} lease=${{ inputs.lease }}",
    );
    const gate = preview.jobs.request;
    const verify = step(
      gate,
      "Verify execution origin and preview reservation",
    );
    expect(verify.with.script).toContain("verifyIsolatedExecutionOrigin");
    expect(verify.with.script).toContain("verifyPreviewRequest");
    expect(
      verify.with.script.indexOf("await verifyIsolatedExecutionOrigin"),
    ).toBeLessThan(verify.with.script.indexOf("await verifyPreviewRequest"));
    expect(verify.with.script).toContain(
      "workflowPath: '.github/workflows/preview-desktop.yml'",
    );
    expect(verify.with.retries).toBe(0);
    expect(gate.permissions).toEqual({
      contents: "read",
      deployments: "read",
      "pull-requests": "read",
    });
    expect(JSON.stringify(gate)).not.toContain("secrets.");
    const build = preview.jobs.build;
    expect(build.needs).toBe("request");
    expect(build.uses).toBe("./.github/workflows/desktop-build.yml");
    expect(build.with).toMatchObject({
      source_ref: "${{ needs.request.outputs.head }}",
      channel: "dev",
      retention_days: 3,
      build_windows: false,
    });
    expect(build.with.artifact_prefix).toBe(
      "${{ needs.request.outputs.artifact_prefix }}",
    );
    expect(build.with.version_suffix).toBe(
      "${{ needs.request.outputs.version_suffix }}",
    );
    expect(preview.concurrency["cancel-in-progress"]).toBe(false);
  });
});
