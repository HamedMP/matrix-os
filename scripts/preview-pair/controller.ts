#!/usr/bin/env bun
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PreviewPairShaSchema, previewPairBundleVersion } from "../../packages/contracts/src/preview-pair.js";
import { PreviewPairControllerReceiptSchema, PreviewPairPreparedSchema, PreviewPairWorkflowRequestSchema, PreviewPairControlOriginSchema } from "../../packages/contracts/src/preview-pair-control.js";
import { createPreviewPairControlClient } from "./control-client.js";
import { createPreviewPairWorkflowClient } from "./github-control.js";
import { previewControllerGitHub, previewDesktopArtifacts, previewRunArtifact } from "./controller-artifacts.js";
import { publishPreviewPairBuild } from "./controller-publish.js";
import { admitBuiltPreviewPair } from "./controller-core.js";

async function main() {
  const env = process.env, pin = PreviewPairShaSchema.parse(env.PAIR_CONTROLLER_SHA);
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "HamedMP/matrix-os" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_RUN_ATTEMPT !== "1"
    || env.GITHUB_SHA !== pin || env.GITHUB_WORKFLOW_SHA !== pin || env.GITHUB_REF !== `refs/heads/preview-pair-controller/${pin}`) throw new Error("Controller origin is unavailable");
  const proof = JSON.parse(await readFile(join(env.RUNNER_TEMP!, "pair-control-origin.json"), "utf8"));
  if (proof?.schemaVersion !== 1 || proof.controllerSha !== pin || proof.executionSha !== pin
    || proof.runId !== Number(env.GITHUB_RUN_ID) || proof.runAttempt !== Number(env.GITHUB_RUN_ATTEMPT)
    || proof.workflowPath !== ".github/workflows/preview-collaboration-pair.yml") throw new Error("Controller origin is unavailable");
  const raw = JSON.parse(env.PAIR_WORKFLOW_INPUTS ?? "{}");
  const input = PreviewPairWorkflowRequestSchema.parse({ pairId: raw.pair_id, generation: Number(raw.generation), pr: Number(raw.pr),
    sourceSha: raw.source_sha, requesterId: raw.requester_id, action: raw.action, ...(raw.base_source_sha ? { baseSourceSha: raw.base_source_sha } : {}) });
  const request = PreviewPairControllerReceiptSchema.parse({ pairId: input.pairId, generation: input.generation, pr: input.pr,
    sourceSha: input.sourceSha, requesterId: input.requesterId, runId: Number(env.GITHUB_RUN_ID) });
  const output = async (key: string, value: unknown) => {
    if (!env.GITHUB_OUTPUT || !/^[a-z_]+$/.test(key)) throw new Error("Controller output is unavailable");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.includes("\n") || text.includes("\r") || text.length > 64 * 1024) throw new Error("Controller output is unavailable");
    await appendFile(env.GITHUB_OUTPUT, `${key}=${text}\n`);
  };
  const summary = async (value: { pairId: string; generation: number; sourceSha: string; state: string }) => {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
      `Preview pair \`${value.pairId}\`, generation ${value.generation}, source \`${value.sourceSha}\`, state **${value.state}**.\n\n` +
      `Report: ${PreviewPairControlOriginSchema.parse(env.PAIR_CONTROL_ORIGIN)}/api/preview-pairs/${value.pairId}\n\nInfrastructure readiness does not qualify the collaboration journey.\n`);
  };
  if (process.argv[2] === "receipt") {
    const directory = join(env.RUNNER_TEMP!, "pair-request");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "request.json"), JSON.stringify(request), { flag: "wx", mode: 0o600 });
    return;
  }
  const controlOrigin = PreviewPairControlOriginSchema.parse(env.PAIR_CONTROL_ORIGIN);
  const operatorControl = () => createPreviewPairControlClient({ origin: controlOrigin, token: env.PAIR_OPERATOR_SECRET! });
  const github = previewControllerGitHub(env.GITHUB_TOKEN!, pin);
  switch (process.argv[2]) {
    case "prepare": {
      const control = operatorControl();
      // Prove the uploaded controller receipt is visible before Source verifies it.
      await previewRunArtifact(github, request.runId, "preview-pair-controller-request");
      const prepared = await control.prepare(request);
      await output("prepared", prepared); await output("build", String(prepared.kind === "request"));
      await output("version", previewPairBundleVersion(request.pairId, request.generation, request.sourceSha));
      if (prepared.kind === "pair") await summary(prepared);
      break;
    }
    case "desktop": {
      const workflow = createPreviewPairWorkflowClient({ token: env.GITHUB_TOKEN!, controllerSha: pin });
      const run = await workflow.dispatchDesktop(input);
      const artifacts = await previewDesktopArtifacts(github, request, run.id);
      await output("artifacts", artifacts);
      break;
    }
    case "publish": {
      const control = operatorControl();
      const prepared = PreviewPairPreparedSchema.parse(JSON.parse(env.PAIR_PREPARED ?? "{}"));
      if (prepared.kind !== "request") throw new Error("Controller request is unavailable");
      const { hostBundle, imageSha256 } = await publishPreviewPairBuild({ github, token: env.GITHUB_TOKEN!, request, prepared, env });
      const candidate = { sourceSha: request.sourceSha, hostBundleVersion: hostBundle.version, hostBundleSha256: hostBundle.sha256,
        desktopArtifacts: JSON.parse(env.PAIR_DESKTOP_ARTIFACTS ?? "[]"), identityIssuer: prepared.buildContext.identityIssuer,
        platformSource: { kind: "candidate", sha: request.sourceSha } };
      const result = await admitBuiltPreviewPair({ control, request, action: input.action, baseSourceSha: input.baseSourceSha, imageSha256, candidate });
      await summary(result);
      break;
    }
    case "cleanup": {
      // Exact operator status verifies run and effective generation before stop.
      // Unknown observations remain durable Source recovery work, never guessed.
      await operatorControl().stopOwned(request);
      break;
    }
    default: throw new Error("Controller phase is unavailable");
  }
}
main().catch((error: unknown) => {
  console.error("[preview-pair] controller phase unavailable", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
