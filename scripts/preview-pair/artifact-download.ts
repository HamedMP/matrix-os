import { PreviewPairArtifactDownloadSchema as Expected, PreviewPairArtifactMetadataSchema as Metadata,
  PreviewPairArtifactCredentialSchema, type PreviewPairArtifactDownloadIdentity } from "../../packages/contracts/src/preview-pair-artifact.js";
import { readPreviewPairJson } from "../../packages/platform/src/preview-pair/http.js";
import { extractPreviewArtifact } from "./artifact-extract.js";
export class PreviewArtifactUnavailable extends Error { constructor() { super("Preview artifact is unavailable"); } }
export interface PreviewArtifactDownloadOptions {
  expected: PreviewPairArtifactDownloadIdentity; token: string; allowFile(name: string): boolean;
  fetchImpl?: typeof fetch; signal?: AbortSignal; temporaryParent?: string;
}
/** Candidate bytes never execute here; only an independently selected artifact
 * identity is accepted. The caller must dispose its owned directory after use. */
export async function downloadPreviewPairArtifact(options: PreviewArtifactDownloadOptions): Promise<{
  directory: string; files: string[]; dispose(): Promise<void>;
}> {
  try {
    const input = Expected.parse(options.expected), token = PreviewPairArtifactCredentialSchema.parse(options.token);
    const signal = AbortSignal.any([options.signal ?? AbortSignal.timeout(30_000), AbortSignal.timeout(30_000)]);
    const api = `https://api.github.com/repos/HamedMP/matrix-os/actions/artifacts/${input.artifactId}`;
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(api, {
      headers, redirect: "error", signal });
    if (!response.ok) { await response.body?.cancel(); throw new PreviewArtifactUnavailable(); }
    const metadata = Metadata.parse(await readPreviewPairJson(response, 256 * 1024));
    if (!response.ok || metadata.id !== input.artifactId || metadata.workflow_run.id !== input.runId || metadata.name !== input.artifactName
      || metadata.size_in_bytes !== input.sizeBytes || metadata.digest !== `sha256:${input.sha256}`) throw new PreviewArtifactUnavailable();
    const redirect = await fetchImpl(`${api}/zip`, { headers, redirect: "manual", signal });
    let location: URL;
    try {
      if (redirect.status !== 302) throw new PreviewArtifactUnavailable();
      const raw = redirect.headers.get("location"); if (!raw || raw.length > 8192) throw new PreviewArtifactUnavailable();
      location = new URL(raw);
      if (location.protocol !== "https:" || location.username || location.password || location.port || location.hash
        || !/^productionresultssa[a-z0-9]{1,32}\.blob\.core\.windows\.net$/.test(location.hostname)) throw new PreviewArtifactUnavailable();
    } finally { await redirect.body?.cancel(); }
    // Deliberately no bearer or other API headers on the provider-signed URL.
    return await extractPreviewArtifact(await fetchImpl(location, { redirect: "error", signal }), {
      ...input, allowFile: options.allowFile, signal, temporaryParent: options.temporaryParent });
  } catch (error: unknown) {
    if (error instanceof PreviewArtifactUnavailable) throw error;
    console.warn("[preview-pair] artifact unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new PreviewArtifactUnavailable();
  }
}
