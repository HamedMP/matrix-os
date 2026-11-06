#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairRoleSchema } from "../../packages/contracts/src/preview-pair.js";
import { previewPairUserControl } from "./control.js";
import { preparePreviewDesktop } from "./desktop-client.js";
import { createPreviewPairProfile, removePreviewPairProfile } from "../../desktop/src/main/preview-pair-profiles.js";
import { startPreviewDesktop } from "./desktop-process.js";

/** Foreground owner of newly spawned apps/artifact lifetime. Reused processes
 * belong to their original launcher and are never killed or deleted here. */
export async function openPreviewPair(options: { control: Awaited<ReturnType<typeof previewPairUserControl>>; pairId: string;
  token: string; platform?: string; arch?: string; signal?: AbortSignal; home?: string }) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const app = await preparePreviewDesktop({ ...options, platform, arch });
  const started: Array<Awaited<ReturnType<typeof startPreviewDesktop>>> = [];
  const stop = () => { void Promise.all(started.map(child => child.stop())); };
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    for (const role of ["owner", "member"] as const) {
      options.signal?.throwIfAborted();
      // Mint immediately before launch. A reset/stop during download invalidates
      // this request or fails the pinned immutable artifact/context comparison.
      const proof = await options.control.launch(options.pairId, { role, platform, arch });
      const ctx = proof.context, member = app.manifest.members[role];
      if (ctx.generation !== app.manifest.generation || ctx.sourceSha !== app.manifest.sourceSha || ctx.artifactId !== app.artifact.artifactId
        || ctx.artifactSha256 !== app.artifact.sha256 || ctx.actorId !== member.actorId || ctx.machineId !== member.machineId
        || ctx.organizationId !== app.manifest.organizationId || ctx.apiOrigin !== app.manifest.apiOrigin) throw new Error("Preview changed during launch; request it again");
      const profile = await createPreviewPairProfile(ctx, options.home);
      started.push(await startPreviewDesktop({ executable: app.executable, proof, userData: profile.userData, signal: options.signal }));
      options.signal?.throwIfAborted();
    }
    console.log(`Preview PR #${app.manifest.pr} ${app.manifest.sourceSha.slice(0, 12)}: Owner and Member are open. Sign in with each dedicated test account. Close both apps or interrupt this command to finish; the cloud pair remains available.`);
    await Promise.all(started.filter(child => !child.reused).map(child => child.closed));
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await Promise.all(started.map(child => child.stop()));
    await app.dispose();
  }
}
async function main() {
  const args = process.argv.slice(2); if (args[0] === "--") args.shift();
  const { values } = parseArgs({ args, options: { pair: { type: "string" }, profile: { type: "string" }, cleanup: { type: "boolean" }, generation: { type: "string" }, role: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("preview:pair:open --pair <uuid> [--profile <normal-control-profile>]. Use --cleanup --generation <n> --role owner|member to explicitly remove one inactive local profile. Opens exact candidate Owner/Member apps with isolated normal-login profiles. Keeps running until newly opened apps close; never merges or changes customer runtimes."); return; }
  const pairId = PreviewPairIdSchema.parse(values.pair);
  if (values.cleanup) {
    await removePreviewPairProfile(pairId, PreviewPairGenerationSchema.parse(Number(values.generation)), PreviewPairRoleSchema.parse(values.role));
    console.log("Removed the selected inactive preview profile. Other profiles and the cloud pair are unchanged."); return;
  }
  const control = await previewPairUserControl(values.profile);
  const token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const abort = new AbortController(), stop = () => abort.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await openPreviewPair({ control, pairId, token, signal: abort.signal }); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.warn("[preview-pair] launch failed", error instanceof Error ? error.name : "UnknownError");
  console.error("Preview apps could not open. Check the current pair report, normal Matrix/GitHub login and supported target. The cloud pair is unchanged."); process.exitCode = 1;
});
