#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PreviewPairIdSchema, PreviewPairPrSchema } from "../../packages/contracts/src/preview-pair.js";
import { PreviewPairControlOriginSchema } from "../../packages/contracts/src/preview-pair-control.js";
import { loadProfiles } from "../../packages/sync-client/src/lib/profiles.js";
import { isExpired, loadProfileAuth } from "../../packages/sync-client/src/auth/token-store.js";
import { createPreviewPairControlClient } from "./control-client.js";
import { createPreviewPairWorkflowClient } from "./github-control.js";

/** Normal Matrix profile only. Check the exact identity origin before reading its
 * credential; never inherit operator secrets, candidate URLs or a legacy token. */
export async function previewPairUserControl(profileName?: string) {
  const settings = await loadProfiles({ migrateLegacyFiles: false }), name = profileName ?? settings.active;
  const profile = settings.profiles[name];
  if (!profile) throw new Error("Matrix profile is unavailable");
  const url = new URL(profile.platformUrl);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Control origin is unavailable");
  const origin = PreviewPairControlOriginSchema.parse(url.origin);
  const auth = await loadProfileAuth(name);
  if (!auth || isExpired(auth)) throw new Error(`Run mos login --profile ${name} before requesting a preview pair`);
  return createPreviewPairControlClient({ origin, token: auth.accessToken });
}
export async function requestPreviewPair(options: { control: ReturnType<typeof createPreviewPairControlClient>;
  githubToken: string; pr?: number; pairId?: string; action: "create" | "update"; uuid?: () => string; fetchImpl?: typeof fetch }) {
  // The control identity must authorize setup before GitHub can mutate anything.
  const setup = await options.control.setup();
  if (!setup.admissionEnabled) throw new Error("Preview admission is unavailable");
  const workflow = createPreviewPairWorkflowClient({ token: options.githubToken, controllerSha: setup.controllerSha, fetchImpl: options.fetchImpl });
  let pr = options.pr, pairId = options.pairId, generation = 1, baseSourceSha: string | undefined;
  if (options.action === "update") {
    const selected = await options.control.report(PreviewPairIdSchema.parse(pairId));
    if ("kind" in selected || !["preparing", "ready", "failed"].includes(selected.state)) throw new Error("Preview update is unavailable");
    pr = selected.pr; pairId = selected.pairId; generation = selected.generation + 1; baseSourceSha = selected.sourceSha;
  } else {
    if (pairId) throw new Error("Create selects a fresh preview identity");
    pairId = (options.uuid ?? randomUUID)();
  }
  const selectedPr = PreviewPairPrSchema.parse(pr);
  const pull = await workflow.pull(selectedPr);
  if (pull.number !== selectedPr) throw new Error("Preview source is unavailable");
  const run = await workflow.dispatch({ pairId: PreviewPairIdSchema.parse(pairId), generation, pr: selectedPr,
    sourceSha: pull.head.sha, requesterId: setup.requesterId, action: options.action,
    ...(baseSourceSha ? { baseSourceSha } : {}) });
  return { pairId, generation, pr: selectedPr, sourceSha: pull.head.sha,
    workflowUrl: `https://github.com/HamedMP/matrix-os/actions/runs/${run.id}`,
    reportUrl: `${options.control.origin}/api/preview-pairs/${pairId}` };
}

async function main() {
  const action = process.argv[2];
  const args = process.argv.slice(3); if (args[0] === "--") args.shift();
  const { values } = parseArgs({ args, options: { help: { type: "boolean" }, pr: { type: "string" }, pair: { type: "string" }, profile: { type: "string" } }, strict: true });
  if (!["create", "update", "report", "stop"].includes(action ?? "")) throw new Error("Use preview:pair:create, update, report or stop");
  if (values.help) {
    console.log("Preview pair: create --pr <number>; update|report|stop --pair <uuid>; optional --profile <normal-control-profile>. Requires reviewed protected preview setup. No command merges or deploys customer computers.");
    return;
  }
  const control = await previewPairUserControl(values.profile);
  if (action === "report" || action === "stop") {
    const id = PreviewPairIdSchema.parse(values.pair), report = await control.report(id);
    if (action === "stop") {
      if ("kind" in report) throw new Error("This request has not been admitted; cancel its recorded GitHub workflow or remove the preview-collaboration-pair label");
      await control.stop(id, report.generation, report.revision);
    }
    console.log(JSON.stringify(action === "stop" ? await control.report(id) : report, null, 2));
    return;
  }
  const token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    stdio: ["ignore", "pipe", "ignore"] }).trim();
  const result = await requestPreviewPair({ control, githubToken: token, action: action as "create" | "update",
    ...(values.pr ? { pr: PreviewPairPrSchema.parse(Number(values.pr)) } : {}), ...(values.pair ? { pairId: PreviewPairIdSchema.parse(values.pair) } : {}) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message.startsWith("Run mos login") ? error.message : "Preview command is unavailable. Check your normal Matrix/GitHub login and the protected preview setup.");
  process.exitCode = 1;
});
