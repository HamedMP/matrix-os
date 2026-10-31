import { PreviewPairShaSchema } from "../../packages/contracts/src/preview-pair.js";
import { PreviewPairPullSchema, PreviewPairWorkflowRequestSchema, PreviewPairWorkflowRunsSchema,
  type PreviewPairWorkflowRequest } from "../../packages/contracts/src/preview-pair-control.js";
import { readPreviewPairJson } from "../../packages/platform/src/preview-pair/http.js";

export class PreviewWorkflowUnavailable extends Error { constructor() { super("Preview workflow is unavailable"); } }
export function previewPairRunTitle(input: Pick<PreviewPairWorkflowRequest, "pairId" | "generation" | "sourceSha">, kind: "pair" | "desktop" = "pair"): string {
  return `Preview ${kind} ${input.pairId} g${input.generation} ${input.sourceSha}`;
}
export function createPreviewPairWorkflowClient(options: { token: string; controllerSha: string; fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void> }) {
  const pin = PreviewPairShaSchema.parse(options.controllerSha), ref = `preview-pair-controller/${pin}`;
  if (!options.token || options.token.length > 16_384) throw new PreviewWorkflowUnavailable();
  const base = "https://api.github.com/repos/HamedMP/matrix-os";
  async function request(path: string, body?: unknown) {
    const response = await (options.fetchImpl ?? fetch)(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${options.token}`, accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new PreviewWorkflowUnavailable(); }
    if (response.status === 204) { await response.body?.cancel(); return undefined; }
    return readPreviewPairJson(response, 1024 * 1024);
  }
  const since = encodeURIComponent(`>=${new Date(Date.now() - 72 * 60 * 60_000).toISOString()}`);
  async function findRun(input: PreviewPairWorkflowRequest, kind: "pair" | "desktop") {
    const workflow = kind === "pair" ? "preview-collaboration-pair.yml" : "desktop-build.yml";
    // Complete bounded pagination is required before absence can authorize one dispatch.
    const matches = [];
    for (let page = 1; page <= 8; page++) {
      const result = PreviewPairWorkflowRunsSchema.parse(await request(`/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(ref)}&event=workflow_dispatch&created=${since}&per_page=100&page=${page}`));
      if (result.total_count > 800 || result.workflow_runs.length !== Math.min(100, Math.max(0, result.total_count - (page - 1) * 100))) throw new PreviewWorkflowUnavailable();
      for (const run of result.workflow_runs) if (run.display_title === previewPairRunTitle(input, kind)) {
        if (run.head_sha !== pin || run.head_branch !== ref || run.path.split("@")[0] !== `.github/workflows/${workflow}`
          || run.actor.id !== run.triggering_actor.id) throw new PreviewWorkflowUnavailable();
        matches.push(run);
        if (matches.length > 1) throw new PreviewWorkflowUnavailable();
      }
      if (result.workflow_runs.length < 100 || page * 100 >= result.total_count) return matches[0];
    }
    throw new PreviewWorkflowUnavailable();
  }
  async function dispatch(raw: PreviewPairWorkflowRequest, kind: "pair" | "desktop") {
      const input = PreviewPairWorkflowRequestSchema.parse(raw);
      const existing = await findRun(input, kind);
      if (existing) return existing;
      if (kind === "pair") await request(`/issues/${input.pr}/labels`, { labels: ["preview-collaboration-pair"] });
      try {
        const workflow = kind === "pair" ? "preview-collaboration-pair.yml" : "desktop-build.yml";
        await request(`/actions/workflows/${workflow}/dispatches`, { ref, inputs: kind === "pair" ? {
          pair_id: input.pairId, generation: String(input.generation), pr: String(input.pr), source_sha: input.sourceSha,
          requester_id: input.requesterId, action: input.action, base_source_sha: input.baseSourceSha ?? "" } : {
          pair_id: input.pairId, pair_generation: String(input.generation), pair_pr: String(input.pr), candidate_sha: input.sourceSha } });
      } catch (error: unknown) {
        // An unknown acknowledgement may have created the run. Never repeat POST.
        console.warn("[preview-pair] workflow dispatch acknowledgement unavailable", error instanceof Error ? error.name : "UnknownError");
      }
      for (let attempt = 0; attempt < 16; attempt++) {
        const observed = await findRun(input, kind);
        if (observed) return observed;
        if (attempt < 15) await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(5000);
      }
      throw new PreviewWorkflowUnavailable();
  }
  return {
    async pull(pr: number) {
      if (!Number.isSafeInteger(pr) || pr < 1 || pr > 999_999_999) throw new PreviewWorkflowUnavailable();
      return PreviewPairPullSchema.parse(await request(`/pulls/${pr}`));
    },
    dispatch: (raw: PreviewPairWorkflowRequest) => dispatch(raw, "pair"),
    dispatchDesktop: (raw: PreviewPairWorkflowRequest) => dispatch(raw, "desktop"),
  };
}
