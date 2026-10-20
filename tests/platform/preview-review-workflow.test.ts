import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";
import YAML from "yaml";
const workflow = YAML.parse(
  readFileSync(".github/workflows/preview-review.yml", "utf8"),
);
const web = YAML.parse(
  readFileSync(".github/workflows/preview-vps.yml", "utf8"),
);
const pin = "b".repeat(40);
function allowed(
  job: string,
  {
    event = "workflow_dispatch",
    ref = `refs/heads/ci-execution/${pin}`,
    origin = "true",
    enabled = "true",
  } = {},
) {
  const code = workflow.jobs[job].if;
  return runInNewContext(code, {
    github: { event_name: event, ref },
    vars: {
      MATRIX_PREVIEW_REVIEW_ENABLED: enabled,
      MATRIX_CI_CONTROLLER_SHA: pin,
    },
    needs: {
      origin: {
        result: origin === "true" ? "success" : "failure",
        outputs: { allowed: origin },
      },
    },
    format: (s: string, v: string) => s.replace("{0}", v),
  });
}
it("forwards manual comment priority without turning it into an admission allowlist", async () => {
    const step = workflow.jobs.route.steps.find((s: any) => s.name === "Dispatch serialized preview reconciliation");
    const script = step.with.script;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    for (const [eventName, payload, expected] of [
      ["workflow_dispatch", { inputs: { requested_pr: "42" } }, "42"],
      ["pull_request_target", { pull_request: { number: 17 }, inputs: { requested_pr: "42" } }, "17"],
      ["schedule", {}, ""],
    ] as const) {
      const dispatches: any[] = [];
      const github = { rest: { actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }),
        createWorkflowDispatch: async (data: any) => dispatches.push(data),
      } } };
      // Exercise the actual router script, replacing only reviewed execution-ref discovery.
      const executable = script.replace(/const \{dispatchExecutionRef\} = await import\([^\n]+\);/, "const dispatchExecutionRef = async () => 'ci-execution/pin';");
      await new AsyncFunction("github", "context", "process", "core", "require", executable)(github,
        { eventName, payload, repo: { owner: "HamedMP", repo: "matrix-os" } },
        { env: { CONTROLLER: pin } }, { notice: () => {} }, (name: string) => name === "node:url"
          ? { pathToFileURL: () => ({ href: "file:///reviewed-controller" }) } : { resolve: () => "reviewed-controller" });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0].inputs.requested_pr).toBe(expected);
    }
});
describe("unified preview workflow authorization and retained checks", () => {
  it("routes metadata-only events while keeping actual scheduler secrets off Main", () => {
    expect(
      allowed("route", {
        event: "pull_request_target",
        ref: "refs/heads/main",
      }),
    ).toBe(true);
    expect(allowed("origin", { ref: "refs/heads/main" })).toBe(false);
    expect(allowed("origin")).toBe(true);
    expect(
      allowed("origin", { ref: `refs/heads/ci-execution/${"c".repeat(40)}` }),
    ).toBe(false);
    expect(JSON.stringify(workflow.jobs.route)).not.toContain("secrets.");
  });
  it("admits credentials only after successful isolated origin verification", () => {
    expect(workflow.jobs.reconcile.needs).toBe("origin");
    expect(allowed("reconcile")).toBe(true);
    expect(allowed("reconcile", { origin: "false" })).toBe(false);
    expect(allowed("origin", { enabled: "false" })).toBe(false);
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });
  it("wakes on label, new heads and close/merge, with completion and bounded scheduled recovery", () => {
    expect(workflow.on.pull_request_target.types).toEqual(
      expect.arrayContaining(["labeled", "unlabeled", "synchronize", "closed"]),
    );
    expect(workflow.on.workflow_run.workflows).toEqual([
      "Preview VPS",
      "Preview Desktop",
    ]);
    expect(workflow.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
    expect(JSON.stringify(workflow)).not.toContain("continue-on-error");
  });
  it("retains the full gateway stability check and exact-head checkout", () => {
    const deploy = web.jobs.deploy.steps.find(
      (s: any) => s.name === "Deploy preview bundle to preview VPS",
    ).run;
    expect(deploy).toContain("until_time=$((SECONDS + 900))");
    expect(deploy).toContain("verify_preview_stability");
    expect(
      web.jobs.build.steps.find((s: any) => s.uses === "actions/checkout@v6")
        .with.ref,
    ).toBe("${{ needs.gate.outputs.head_sha }}");
  });
  it("revalidates current source and reservation after build before privileged publication", async () => {
    const step = web.jobs.deploy.steps.find(
      (s: any) => s.name === "Revalidate queued source before publication",
    );
    const run = new (Object.getPrototypeOf(async () => {}).constructor)(
      "github",
      "context",
      step.with.script,
    );
    const head = "a".repeat(40),
      live = {
        number: 1,
        state: "open",
        head: { sha: head },
        labels: [{ name: "preview" }],
      };
    const lease = {
      id: 1,
      sha: head,
      creator: { login: "github-actions[bot]" },
      payload: {
        schema: "matrix-preview-v1",
        pr: 1,
        head,
        expiresAt: "2099-10-22T00:00:00Z",
      },
    };
    const latest = { state: "in_progress", description: "Build/deploy in progress" };
    const github = {
      rest: {
        pulls: { get: async () => ({ data: live }) },
        repos: {
          getDeployment: async () => ({ data: lease }),
          listDeploymentStatuses: async () => ({
            data: [latest],
          }),
        },
      },
    };
    const context = {
      repo: { owner: "HamedMP", repo: "matrix-os" },
      payload: { inputs: { pr: "1", expected_head: head, preview_lease: "1" } },
    };
    await expect(run(github, context)).resolves.toBeUndefined();
    latest.description = "Cleanup started: Waiting for physical preview cleanup confirmation";
    await expect(run(github, context)).rejects.toThrow("stopped");
    latest.description = "Build/deploy in progress";
    lease.payload.expiresAt = "2000-01-01T00:00:00Z";
    await expect(run(github, context)).rejects.toThrow("expired");
    lease.payload.expiresAt = "2099-10-22T00:00:00Z";
    live.head.sha = "c".repeat(40);
    await expect(run(github, context)).rejects.toThrow("source changed");
  });
});

it("coalesces event bursts before controller proof and workflow dispatch", async () => {
  const script = workflow.jobs.route.steps.find(
    (s: any) => s.name === "Dispatch serialized preview reconciliation",
  ).with.script;
  let reads = 0,
    notices = 0;
  await runInNewContext(`(async()=>{${script}})()`, {
    github: {
      rest: {
        actions: {
          listWorkflowRuns: async () => {
            reads++;
            return {
              data: {
                workflow_runs: [
                  {
                    event: "workflow_dispatch",
                    head_branch: `ci-execution/${pin}`,
                    created_at: new Date().toISOString(),
                  },
                ],
              },
            };
          },
        },
      },
    },
    context: { repo: { owner: "HamedMP", repo: "matrix-os" } },
    process: { env: { CONTROLLER: pin } },
    Date,
    core: { notice: () => notices++ },
    require: () => {
      throw new Error("Controller proof should not execute");
    },
  });
  expect(reads).toBe(1);
  expect(notices).toBe(1);
});
