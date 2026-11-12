import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qualifyPreviewPair } from "../../scripts/preview-pair/qualify.js";
import { createPreviewPairControlClient } from "../../scripts/preview-pair/control-client.js";
import { previewPairManifestFixture, PAIR_NOW } from "../platform/preview-pair-test-support.js";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "eng418-qualification-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture(changed = false) {
  const manifest = previewPairManifestFixture();
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url).startsWith("https://app.matrix-os.com/api/preview-pairs/")).toBe(true);
    expect(init?.method).toBe("GET"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer normal-control-fixture");
    return Response.json(String(url).endsWith("/manifest") ? manifest : { pairId: manifest.pairId, generation: changed ? 2 : 1, sourceSha: manifest.sourceSha,
      state: "ready", revision: 3, pr: manifest.pr, outdated: false, expiresAt: manifest.expiresAt });
  });
  const control = createPreviewPairControlClient({ origin: "https://app.matrix-os.com", token: "normal-control-fixture", now: () => PAIR_NOW, fetchImpl });
  const resultsPath = join(directory, "observations.json"), outputPath = join(directory, "report.json");
  const waitForResults = vi.fn(async () => { const template = JSON.parse(await readFile(resultsPath, "utf8")); expect(template.observations).toHaveLength(16); });
  return { control, pairId: manifest.pairId, resultsPath, outputPath, waitForResults, now: () => PAIR_NOW, fetchImpl };
}
it("uses real authenticated Source reads and exports all untouched cases as not run", async () => {
  const f = fixture(); await qualifyPreviewPair(f);
  const report = JSON.parse(await readFile(f.outputPath, "utf8"));
  expect(report.summary).toMatchObject({ pending: 16, liveReportedPasses: 0, requiresReview: true });
  expect(f.fetchImpl).toHaveBeenCalledTimes(2); expect(f.waitForResults).toHaveBeenCalledOnce();
});
it("does not export stale observations after Source changes generation", async () => {
  const f = fixture(true); await expect(qualifyPreviewPair(f)).rejects.toThrow();
  await expect(readFile(f.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not overwrite an existing operator-owned observation file", async () => {
  const f = fixture(); await writeFile(f.resultsPath, "keep my observations");
  await expect(qualifyPreviewPair(f)).rejects.toThrow(); expect(await readFile(f.resultsPath, "utf8")).toBe("keep my observations"); expect(f.waitForResults).not.toHaveBeenCalled();
});
