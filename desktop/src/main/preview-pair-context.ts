import { BuildSourceSchema, type BuildSource } from "@matrix-os/contracts";
import { PreviewPairLaunchAttestationSchema, PreviewPairLaunchVerificationSchema,
  type PreviewPairLaunchContext } from "@matrix-os/contracts/preview-pair-launch";

declare const verifiedContext: unique symbol;
export type VerifiedDesktopPreviewContext = Readonly<PreviewPairLaunchContext> & { readonly [verifiedContext]: true };
class PreviewContextUnavailable extends Error { constructor() { super("Preview context is unavailable"); } }

/** No filesystem, profile, user credential or arbitrary target is touched here.
 * The Source proof is non-authorizing; normal test login still follows. */
export async function verifyDesktopPreviewContext(raw: string | undefined, options: { buildSource: BuildSource | null;
  platform?: string; arch?: string; now?: () => number; fetchFn?: typeof fetch }): Promise<VerifiedDesktopPreviewContext | null> {
  if (raw === undefined) return null;
  try {
    if (Buffer.byteLength(raw) > 16 * 1024) throw new PreviewContextUnavailable();
    const proof = PreviewPairLaunchAttestationSchema.parse(JSON.parse(raw)), context = proof.context;
    const source = BuildSourceSchema.safeParse(options.buildSource), now = (options.now ?? Date.now)();
    if (!source.success || source.data.commit !== context.sourceSha || context.platform !== (options.platform ?? process.platform)
      || context.arch !== (options.arch ?? process.arch) || !Number.isFinite(now)
      || Date.parse(context.verifyBefore) <= now || Date.parse(context.issuedAt) > now + 5000) throw new PreviewContextUnavailable();
    const response = await (options.fetchFn ?? fetch)(`${context.sourceOrigin}/api/preview-pairs/launch/verify`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); throw new PreviewContextUnavailable(); }
    if (!response.body) throw new PreviewContextUnavailable();
    const reader = response.body.getReader(); let bytes = 0, text = ""; const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024) { await reader.cancel(); throw new PreviewContextUnavailable(); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    PreviewPairLaunchVerificationSchema.parse(JSON.parse(text));
    return Object.freeze(context) as VerifiedDesktopPreviewContext;
  } catch (error: unknown) {
    if (!(error instanceof PreviewContextUnavailable)) console.warn("[preview-pair] startup verification unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new PreviewContextUnavailable();
  }
}
