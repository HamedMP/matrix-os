import { describe, expect, it, vi } from "vitest";
import { createPreviewPairWorkflowClient, previewPairRunTitle } from "../../scripts/preview-pair/github-control.js";
const pin = "c".repeat(40), sha = "a".repeat(40), ref = `preview-pair-controller/${pin}`;
const input = { pairId: "11111111-1111-4111-8111-111111111111", generation: 1, pr: 3022,
  sourceSha: sha, requesterId: "user_maintainer", action: "create" as const };
const run = () => ({ id: 42, head_sha: pin, head_branch: ref, display_title: previewPairRunTitle(input),
  path: ".github/workflows/preview-collaboration-pair.yml", event: "workflow_dispatch", actor: { id: 10 }, triggering_actor: { id: 10 },
  repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" }, status: "queued", conclusion: null });
function setup(mode: "normal" | "lost-ack" | "existing" | "duplicate" | "foreign" | "incomplete" = "normal") {
  let dispatched = mode === "existing" || mode === "duplicate" || mode === "foreign";
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).origin).toBe("https://api.github.com");
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    if (String(url).endsWith("/dispatches")) { dispatched = true;
      if (mode === "lost-ack") throw new TypeError("lost response");
      expect(JSON.parse(String(init?.body))).toMatchObject({ ref, inputs: { pair_id: input.pairId, source_sha: sha } });
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith("/labels")) return Response.json([]);
    const items = dispatched ? [run()] : [];
    if (mode === "foreign") items[0]!.head_sha = sha;
    if (mode === "duplicate") items.push({ ...run(), id: 43 });
    return Response.json({ total_count: mode === "incomplete" ? 801 : items.length, workflow_runs: items });
  });
  const client = createPreviewPairWorkflowClient({ token: "test-token", controllerSha: pin, fetchImpl, sleep: async () => undefined });
  return { client, fetchImpl };
}
describe("normal-user preview workflow request", () => {
  it.each(["normal", "lost-ack", "existing"] as const)("correlates one exact reviewed run on %s without repeating a dispatch", async mode => {
    const s = setup(mode);
    expect(await s.client.dispatch(input)).toMatchObject({ id: 42, head_sha: pin });
    expect(s.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(mode === "existing" ? 0 : 1);
  });
  it.each(["duplicate", "foreign", "incomplete"] as const)("holds %s run evidence before mutation", async mode => {
    const s = setup(mode);
    await expect(s.client.dispatch(input)).rejects.toThrow("unavailable");
    expect(s.fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/dispatches"))).toBe(false);
  });
});

import { createPreviewPairControlClient } from "../../scripts/preview-pair/control-client.js";
import { requestPreviewPair } from "../../scripts/preview-pair/control.js";
describe("request command binds verified normal-login actor and current PR head", () => {
  function command() {
    const workflow = setup();
    const source = vi.fn<typeof fetch>(async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer root-user-session");
      if (String(url).endsWith("/setup")) return Response.json({ controllerSha: pin, controllerRef: ref, requesterId: "user_maintainer", admissionEnabled: true });
      return Response.json({ pairId: input.pairId, pr: input.pr, generation: 1, revision: 8, sourceSha: "b".repeat(40), state: "ready", outdated: true, expiresAt: "2026-11-02T00:00:00Z" });
    });
    const fetchImpl = vi.fn<typeof fetch>((url, init) => String(url).includes("/pulls/") ? Promise.resolve(Response.json({ number: input.pr, state: "open",
      head: { sha, repo: { full_name: "HamedMP/matrix-os" } }, base: { repo: { full_name: "HamedMP/matrix-os" } }, labels: [] })) : workflow.fetchImpl(url, init));
    return { control: createPreviewPairControlClient({ origin: "https://app.matrix-os.com", token: "root-user-session", fetchImpl: source }), fetchImpl, source };
  }
  it("uses the server requester and exact open PR SHA rather than caller identity or a mutable branch", async () => {
    const s = command();
    expect(await requestPreviewPair({ ...s, githubToken: "test-token", action: "create", pr: 3022, uuid: () => input.pairId })).toMatchObject({
      pairId: input.pairId, sourceSha: sha, workflowUrl: "https://github.com/HamedMP/matrix-os/actions/runs/42" });
  });
  it("selects a canonical parent before update and preserves its immutable source in the dispatch", async () => {
    const s = command();
    // The exact target generation gets a distinct title; capture dispatch inputs
    // and emulate GitHub's independently returned run metadata for that target.
    let body: any;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/dispatches")) { body = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); }
      if (String(url).includes("/runs?")) return Response.json({ total_count: body ? 1 : 0, workflow_runs: body ? [{ ...run(), display_title: previewPairRunTitle({ ...input, generation: 2 }) }] : [] });
      if (String(url).endsWith("/labels")) return Response.json([]);
      return s.fetchImpl(url, init);
    });
    await requestPreviewPair({ ...s, fetchImpl, githubToken: "test-token", action: "update", pairId: input.pairId });
    expect(body.inputs).toMatchObject({ generation: "2", source_sha: sha, base_source_sha: "b".repeat(40), requester_id: "user_maintainer" });
  });
});

import { readFileSync } from "node:fs";
import { parse } from "yaml";
describe("actual protected workflow credential and execution wiring", () => {
  const flow = parse(readFileSync(".github/workflows/preview-collaboration-pair.yml", "utf8"));
  const action = parse(readFileSync(".github/actions/preview-pair-controller/action.yml", "utf8"));
  it("gates every candidate builder on durable admission with no privileged credentials or OIDC", () => {
    expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
    for (const name of ["platform", "host"]) {
      const job = flow.jobs[name];
      expect(job.needs).toContain("admission"); expect(job.if).toContain("needs.admission.outputs.build");
      expect(job.permissions).toEqual({ contents: "read" }); expect(job.environment).toBe("collaboration-preview-build");
      expect(JSON.stringify(job)).not.toMatch(/secrets\.|id-token|google-github-actions|PAIR_OPERATOR_SECRET|PAIR_REGISTRY_TOKEN/);
      expect(job.steps[0].with).toMatchObject({ ref: "${{ inputs.source_sha }}", "persist-credentials": false });
    }
  });
  it("uses a fresh reviewed checkout and actual pre-credential origin verifier for privileged phases", () => {
    for (const name of ["admission", "desktop", "publish", "cleanup"]) {
      const job = flow.jobs[name];
      expect(job.environment).toBe("collaboration-preview-control");
      expect(job.steps[0].with).toMatchObject({ path: "controller", ref: "${{ vars.MATRIX_PREVIEW_PAIR_CONTROLLER_SHA }}", "persist-credentials": false });
      expect(job.steps[1].uses).toBe("./controller/.github/actions/preview-pair-controller");
      expect(JSON.stringify(job)).not.toMatch(/with[^}]*path[^}]*candidate|working-directory":"candidate|docker build|electron-builder|scripts\/build-host-bundle/);
    }
    expect(action.runs.steps[0].with.script).toContain("verifyPreviewPairControlOrigin");
    expect(action.runs.steps[0].with.script).toContain("GITHUB_WORKFLOW_SHA");
    expect(action.runs.steps.at(-1).run).toContain("--frozen-lockfile --ignore-scripts");
    expect(flow.jobs.admission.steps.findIndex((s: any) => s.with?.name === "preview-pair-controller-request"))
      .toBeLessThan(flow.jobs.admission.steps.findIndex((s: any) => s.id === "prepare"));
    expect(flow.jobs.cleanup.if).toContain("cancelled()");
    expect(JSON.stringify(flow.jobs.publish)).not.toMatch(/deploy_after_publish|--channel stable|--publish always/);
  });
});
