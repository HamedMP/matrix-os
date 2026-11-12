#!/usr/bin/env bun
import { constants } from "node:fs";
import { lstat, open, realpath, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { PreviewPairIdSchema } from "../../packages/contracts/src/preview-pair.js";
import { createPreviewQualification, PREVIEW_QUALIFICATION_SCENARIOS } from "../../packages/platform/src/preview-pair/evidence.js";
import { previewPairUserControl } from "./control.js";
import type { createPreviewPairControlClient } from "./control-client.js";

export async function writeQualificationExport(path: string, data: unknown) {
  const target = resolve(path), parent = await realpath(dirname(target)), stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error("Qualification output is unavailable");
  const temp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`), file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); await file.close();
    // Atomic and exclusive: a completed operator export is never replaced.
    await link(temp, join(parent, basename(target)));
  } finally { await file.close(); await unlink(temp); }
}
async function readObservations(path: string) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 64 * 1024 || stat.mode & 0o077) throw new Error("Qualification observations are unavailable");
    const bytes = Buffer.alloc(64 * 1024 + 1), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 64 * 1024) throw new Error("Qualification observations are unavailable");
    return JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")) as unknown;
  } finally { await file.close(); }
}
/** Guided human acceptance, not an automated product-pass oracle. Root access
 * only reads Source metadata; users act through their normal test-account UIs.
 * Completed JSON is a portable owner-controlled export, never new app state. */
export async function qualifyPreviewPair(options: { control: ReturnType<typeof createPreviewPairControlClient>; pairId: string;
  resultsPath: string; outputPath: string; waitForResults(): Promise<void>; now?: () => number }) {
  if (resolve(options.resultsPath) === resolve(options.outputPath)) throw new Error("Choose separate qualification files");
  const pairId = PreviewPairIdSchema.parse(options.pairId), now = options.now ?? Date.now, manifest = await options.control.manifest(pairId), startedAt = now();
  const observations = Object.entries(PREVIEW_QUALIFICATION_SCENARIOS).flatMap(([scenario, definition]) =>
    ["web_desktop", "electron_desktop"].map(surface => ({ scenario, surface, role: definition.role, boundary: "live", result: "not_run",
      observedAt: new Date(startedAt).toISOString(), steps: [], captures: [] })));
  await writeQualificationExport(options.resultsPath, { pairId, generation: manifest.generation, sourceSha: manifest.sourceSha, observations });
  await options.waitForResults();
  const input = await readObservations(options.resultsPath), current = await options.control.report(pairId);
  const report = createPreviewQualification({ manifest, current, startedAt, now: now(), input });
  await writeQualificationExport(options.outputPath, report);
  return report;
}
async function main() {
  const args = process.argv.slice(2); if (args[0] === "--") args.shift();
  const { values } = parseArgs({ args, strict: true, options: { help: { type: "boolean" }, pair: { type: "string" }, profile: { type: "string" }, results: { type: "string" }, output: { type: "string" } } });
  if (values.help) {
    console.log("preview:pair:qualify --pair <uuid> --results <new-observations.json> --output <new-report.json> [--profile <normal-control-profile>]. Guides normal-login manual Web Desktop/Electron Desktop journeys; reads Source and writes private local exports only. Fixture successes never count as live acceptance; every report needs review."); return;
  }
  if (!values.results || !values.output) throw new Error("Choose new qualification files");
  const control = await previewPairUserControl(values.profile);
  const report = await qualifyPreviewPair({ control, pairId: PreviewPairIdSchema.parse(values.pair), resultsPath: values.results, outputPath: values.output,
    async waitForResults() {
      console.log("A fresh private observation template is ready. Keep normal Owner/Member/outsider test logins. Use a new project for creation opt-in and a different new project for first later Share. Observe actual publication, inherited Chat prompt/reopen, outsider denial, restart, failed publication privacy and exact cleanup. Edit the template with observed steps and clean screenshot/recording links; leave untested cases not_run. No sharing action is performed by this command.");
      console.log(JSON.stringify(PREVIEW_QUALIFICATION_SCENARIOS, null, 2));
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { await input.question("Press Enter after saving your observations to export the unreviewed report: "); }
      finally { input.close(); }
    } });
  console.log(JSON.stringify(report.summary));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  console.warn("[preview-pair] qualification unavailable", error instanceof Error ? error.name : "UnknownError");
  console.error("Qualification export failed. Check the current pair, normal control login, new private output paths and strict observation format. Existing observations are preserved."); process.exitCode = 1;
});
