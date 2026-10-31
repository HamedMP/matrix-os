import { createPreviewPairGitHub } from "../../packages/platform/src/preview-pair/github.js";
import { createPreviewPairBuildReceipts } from "./build-request.mjs";
import { PreviewPairDesktopArtifactSchema } from "../../packages/contracts/src/preview-pair.js";
import type { PreviewPairControllerReceipt } from "../../packages/contracts/src/preview-pair-control.js";
import { PreviewPairArtifactDownloadSchema, PreviewPairArtifactPageSchema } from "../../packages/contracts/src/preview-pair-artifact.js";

export const previewControllerGitHub = (token: string, controllerSha: string) => createPreviewPairGitHub({ token, reviewedControllerSha: controllerSha });
export async function previewRunArtifact(github: ReturnType<typeof previewControllerGitHub>, runId: number, name: string) {
  const page = PreviewPairArtifactPageSchema.parse(await github.api(`/actions/runs/${runId}/artifacts?per_page=17`));
  const matches = page.artifacts.filter(item => item.name === name && item.expired === false);
  if (matches.length !== 1) throw new Error("Preview artifacts are unavailable");
  const item = matches[0]!;
  const metadata = await github.artifact(item.id);
  if (metadata.id !== item.id || metadata.name !== name || metadata.workflow_run?.id !== runId) throw new Error("Preview artifacts are unavailable");
  return PreviewPairArtifactDownloadSchema.parse({ artifactId: metadata.id, artifactName: name, runId,
    sha256: metadata.digest.slice(7), sizeBytes: metadata.size_in_bytes });
}
export async function previewDesktopArtifacts(github: ReturnType<typeof previewControllerGitHub>, request: PreviewPairControllerReceipt, runId: number) {
  const deadline = Date.now() + 50 * 60_000;
  for (let attempt = 0; attempt < 300 && Date.now() < deadline; attempt++) {
    const build = await github.build(runId);
    if (build.status === "completed") {
      if (build.conclusion !== "success") throw new Error("Preview desktop build is unavailable");
      const pull = await github.pullRequest(request.pr), page = PreviewPairArtifactPageSchema.parse(await github.api(`/actions/runs/${runId}/artifacts?per_page=17`));
      const receipts = createPreviewPairBuildReceipts({ pr: String(request.pr), pairId: request.pairId,
        generation: String(request.generation), sourceSha: request.sourceSha }, pull, { repository: "HamedMP/matrix-os",
        event: "workflow_dispatch", sha: build.head_sha, reviewedControllerSha: build.head_sha, runId }, page.artifacts);
      const artifacts = [];
      for (const receipt of receipts) {
        // Independent provider receipt consumer also checks completed run and exact bytes.
        await github.buildSource(runId, receipt.artifactId);
        artifacts.push(PreviewPairDesktopArtifactSchema.parse({ runId: receipt.runId, artifactId: receipt.artifactId, platform: receipt.platform,
          arch: receipt.arch, sourceSha: receipt.sourceSha, sha256: receipt.sha256, sizeBytes: receipt.sizeBytes, artifactName: `preview-pair-desktop-${receipt.sourceSha}-${receipt.platform}-${receipt.arch}`,
          workflow: ".github/workflows/desktop-build.yml", format: "zip",
          executableRelativePath: receipt.platform === "darwin" ? "Matrix OS.app/Contents/MacOS/Matrix OS" : "desktop" }));
      }
      return artifacts;
    }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  throw new Error("Preview desktop build is unavailable");
}
