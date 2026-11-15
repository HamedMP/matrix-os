import { describe, expect, it, vi } from "vitest";
import { verifyPreviewPairControlOrigin } from "../../scripts/preview-pair/control-origin.mjs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse } from "yaml";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pin = "c".repeat(40), main = "a".repeat(40), tree = "d".repeat(40);
function setup() {
  const ref = `preview-pair-controller/${pin}`;
  const context = { repo: { owner: "HamedMP", repo: "matrix-os" }, eventName: "workflow_dispatch", sha: pin,
    ref: `refs/heads/${ref}`, runId: 42, runAttempt: 1, workflowSha: pin,
    workflowRef: `HamedMP/matrix-os/.github/workflows/preview-collaboration-pair.yml@refs/heads/${ref}` };
  const branch = { name: ref, commit: { sha: pin } }, comparison = { status: "behind", merge_base_commit: { sha: main } };
  const run = { id: 42, run_attempt: 1, event: "workflow_dispatch", head_sha: pin, head_branch: ref,
    path: ".github/workflows/preview-collaboration-pair.yml", status: "in_progress", conclusion: null,
    repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" },
    actor: { id: 100 }, triggering_actor: { id: 100 } };
  const github = { rest: { repos: { getBranch: vi.fn(async ({ branch: name }: { branch: string }) => ({ data: name === "main"
    ? { name: "main", commit: { sha: main } } : branch })), compareCommitsWithBasehead: vi.fn(async () => ({ data: comparison })),
    getCommit: vi.fn(async () => ({ data: { sha: pin, commit: { tree: { sha: tree } } } })) },
    actions: { getWorkflowRun: vi.fn(async () => ({ data: run })) } } };
  return { context, branch, comparison, run, github, verify: () => verifyPreviewPairControlOrigin(github, context, pin) };
}
describe("protected preview controller execution origin", () => {
  it("executes the action adapter with GitHub's inherited repository getter", async () => {
    const s = setup(), root = await mkdtemp(resolve(tmpdir(), "pair-controller-context-"));
    try {
      await symlink(process.cwd(), resolve(root, "controller"), "dir");
      const action = parse(await readFile(".github/actions/preview-pair-controller/action.yml", "utf8"));
      // Execute the unchanged production script in Node, outside Vitest's import VM.
      // @actions/github Context.repo is a prototype getter, not an own property.
      const harness = `
        const f = JSON.parse(process.argv[1]);
        const {repo, ...ownContext} = f.context;
        const context = Object.assign(Object.create({get repo() {return repo;}}), ownContext);
        const github = {rest: {repos: {
          getBranch: async ({branch}) => ({data: branch === 'main' ? {name: 'main', commit: {sha: f.main}} : f.branch}),
          compareCommitsWithBasehead: async () => ({data: f.comparison}),
          getCommit: async () => ({data: {sha: f.pin, commit: {tree: {sha: f.tree}}}})
        }, actions: {getWorkflowRun: async () => ({data: f.run})}}};
        ${action.runs.steps[0].with.script}
      `;
      await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", harness,
        JSON.stringify({ context: s.context, branch: s.branch, comparison: s.comparison, run: s.run, pin, main, tree })], {
        timeout: 10_000, maxBuffer: 64 * 1024,
        env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: root, PAIR_CONTROLLER_SHA: pin,
          GITHUB_WORKFLOW_SHA: pin, GITHUB_WORKFLOW_REF: s.context.workflowRef, GITHUB_RUN_ATTEMPT: "1" },
      });
      expect(JSON.parse(await readFile(resolve(root, "pair-control-origin.json"), "utf8")))
        .toMatchObject({ controllerSha: pin, treeSha: tree, runId: 42 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("checks a pinned non-Main controller and its real run before credentials are used", async () => {
    const s = setup();
    expect(await s.verify()).toMatchObject({ controllerSha: pin, executionSha: pin, treeSha: tree, actorId: 100, runId: 42 });
    expect(s.github.rest.repos.compareCommitsWithBasehead).toHaveBeenCalledWith(expect.objectContaining({ basehead: `${pin}...${main}` }));
  });
  it.each(["source", "workflow", "ref", "path"])("rejects %s execution before any provider read", async fault => {
    const s = setup();
    if (fault === "source") s.context.sha = main;
    if (fault === "workflow") s.context.workflowSha = main;
    if (fault === "ref") s.context.ref = "refs/heads/main";
    if (fault === "path") s.context.workflowRef = s.context.workflowRef.replace("preview-collaboration-pair", "desktop-build");
    await expect(s.verify()).rejects.toThrow("unavailable"); expect(s.github.rest.repos.getBranch).not.toHaveBeenCalled();
  });
  it.each(["moved", "ancestor", "actor", "attempt", "foreign", "run-source"])("holds %s provider proof without granting execution authority", async fault => {
    const s = setup();
    if (fault === "moved") s.branch.commit.sha = main;
    if (fault === "ancestor") { s.comparison.status = "ahead"; s.comparison.merge_base_commit.sha = pin; }
    if (fault === "actor") s.run.triggering_actor.id = 101;
    if (fault === "attempt") s.run.run_attempt = 2;
    if (fault === "foreign") s.run.head_repository.full_name = "attacker/matrix-os";
    if (fault === "run-source") s.run.head_sha = main;
    await expect(s.verify()).rejects.toThrow("unavailable");
  });
});
