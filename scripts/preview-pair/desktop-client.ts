import type { createPreviewPairControlClient } from "./control-client.js";
import { createPreviewPairGitHub } from "../../packages/platform/src/preview-pair/github.js";
import { downloadPreviewPairArtifact } from "./artifact-download.js";
import { extractPreviewDesktop } from "./desktop-archive.js";
export async function preparePreviewDesktop(options: { control: ReturnType<typeof createPreviewPairControlClient>; pairId: string;
  token: string; platform: string; arch: string; fetchImpl?: typeof fetch; temporaryParent?: string }) {
  const manifest = await options.control.manifest(options.pairId);
  const artifact = manifest.desktopArtifacts.find(item => item.platform === options.platform && item.arch === options.arch);
  if (!artifact || !["darwin", "linux"].includes(options.platform) || artifact.format !== "zip") throw new Error("Preview desktop target is unavailable");
  const setup = await options.control.setup(), github = createPreviewPairGitHub({ token: options.token, reviewedControllerSha: setup.controllerSha, fetchImpl: options.fetchImpl });
  const source = await github.buildSource(artifact.runId, artifact.artifactId);
  if (source.sourceSha !== manifest.sourceSha || source.workflowSha !== setup.controllerSha) throw new Error("Preview desktop source is unavailable");
  const downloaded = await downloadPreviewPairArtifact({ expected: { artifactId: artifact.artifactId, runId: artifact.runId, artifactName: artifact.artifactName,
    sha256: artifact.sha256, sizeBytes: artifact.sizeBytes }, token: options.token,
    allowFile: name => name === "preview-pair-app.tar.gz", fetchImpl: options.fetchImpl, temporaryParent: options.temporaryParent });
  let app: Awaited<ReturnType<typeof extractPreviewDesktop>> | undefined;
  try {
    if (downloaded.files.length !== 1) throw new Error("Preview desktop artifact is unavailable");
    app = await extractPreviewDesktop(`${downloaded.directory}/preview-pair-app.tar.gz`, artifact.executableRelativePath, options.temporaryParent);
    return { ...app, manifest, artifact };
  } finally {
    try { await downloaded.dispose(); }
    catch (error: unknown) {
      // Ownership reaches the caller only after this finally block succeeds.
      // A failed download cleanup must not orphan the already-extracted app.
      await app?.dispose();
      throw error instanceof Error ? error : new Error("Preview desktop preparation failed");
    }
  }
}
