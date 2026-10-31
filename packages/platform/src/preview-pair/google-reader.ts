import { z } from "zod/v4";
import { PreviewPairSecretBindingSchema, type PreviewPairSecretBinding } from "./source-profile.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";

const Token = z.object({ access_token: z.string().min(1).max(16_384), token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(86_400) });
const Secret = z.object({ name: z.string().max(256), payload: z.object({
  data: z.string().min(4).max(16_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  dataCrc32c: z.string().min(1).max(10).regex(/^[0-9]+$/),
}) });
function checksum(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (-(crc & 1) & 0x82f63b78);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed metadata endpoint (not caller-controlled SSRF) and numeric immutable
 * SecretVersion resources. No candidate URL or bearer ever enters this client.
 * https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/access */
export function createPreviewPairGoogleReader(options: { projectNumber: string; fetchImpl?: typeof fetch }) {
  const project = z.string().min(6).max(20).regex(/^[1-9][0-9]*$/).parse(options.projectNumber), fetchImpl = options.fetchImpl ?? fetch;
  async function guarded<T>(signal: AbortSignal, work: (deadline: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try { return await work(AbortSignal.any([signal, AbortSignal.timeout(10_000)])); }
    catch (error: unknown) {
      if (signal.aborted) throw error;
      console.warn("[preview-pair] credentials unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new PreviewPairUpstreamError();
    }
  }
  async function accessToken(signal: AbortSignal): Promise<string> {
    return guarded(signal, async deadline => {
      const response = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
        headers: { "Metadata-Flavor": "Google" }, redirect: "error", signal: deadline });
      if (response.headers.get("metadata-flavor") !== "Google") { await response.body?.cancel(); throw new PreviewPairUpstreamError(); }
      return Token.parse(await readPreviewPairJson(response, 32_768)).access_token;
    });
  }
  return { accessToken, async secret(binding: PreviewPairSecretBinding, signal: AbortSignal): Promise<string> {
    return guarded(signal, async deadline => {
      const ref = PreviewPairSecretBindingSchema.parse(binding);
      const resource = `projects/${project}/secrets/${ref.ref}/versions/${ref.version}`, token = await accessToken(deadline);
      const response = await fetchImpl(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
        headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: deadline });
      const result = Secret.parse(await readPreviewPairJson(response, 32_768)), bytes = Buffer.from(result.payload.data, "base64");
      if (result.name !== resource || bytes.length > 8192 || bytes.toString("base64") !== result.payload.data
        || Number(result.payload.dataCrc32c) !== checksum(bytes)) throw new PreviewPairUpstreamError();
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!value || value.includes("\0")) throw new PreviewPairUpstreamError();
      return value;
    });
  } };
}
