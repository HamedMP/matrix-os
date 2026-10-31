import type { PreviewPairWorkflowRequest, PreviewPairControllerReceipt } from "../../packages/contracts/src/preview-pair-control.js";
import type { createPreviewPairControlClient } from "./control-client.js";

/** Reviewed code only. Source independently verifies each effect and journals
 * publication; repeated publication calls observe the same immutable operation. */
export async function admitBuiltPreviewPair(options: { control: ReturnType<typeof createPreviewPairControlClient>;
  request: PreviewPairControllerReceipt; action: PreviewPairWorkflowRequest["action"]; baseSourceSha?: string;
  imageSha256: string; candidate: Record<string, unknown>; sleep?: (ms: number) => Promise<void> }) {
  const { control, request } = options;
  const pause = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let admissionAttempted = false;
  try {
    let publication: Awaited<ReturnType<typeof control.publish>> | undefined;
    const publicationDeadline = Date.now() + 10 * 60_000;
    for (let attempt = 0; attempt < 120 && Date.now() < publicationDeadline; attempt++) {
      publication = await control.publish(request, options.imageSha256);
      if (publication.publication === "rejected") throw new Error("Preview publication is unavailable");
      if (publication.ready) break;
      await pause(5000);
    }
    if (!publication?.ready || !publication.browserOrigin || !publication.apiOrigin || !publication.sourceProfileFingerprint) {
      throw new Error("Preview publication is unavailable");
    }
    const candidate = { ...options.candidate, browserOrigin: publication.browserOrigin, apiOrigin: publication.apiOrigin,
      sourceProfileFingerprint: publication.sourceProfileFingerprint };
    admissionAttempted = true;
    const result = options.action === "update" ? await control.adopt(request, request.generation - 1, options.baseSourceSha ?? "", candidate)
      : await control.start(request, candidate);
    if (!result.ownedRequest) { await control.stopRequest(request); return result; }
    const readyDeadline = Date.now() + 10 * 60_000;
    for (let attempt = 0; attempt < 120 && Date.now() < readyDeadline; attempt++) {
      const status = await control.status(request);
      if (status.kind !== "pair" || ["failed", "cleanup_pending", "stopped"].includes(status.state)) throw new Error("Preview readiness is unavailable");
      if (status.state === "ready" && status.infrastructureReady) return status;
      await pause(5000);
    }
    throw new Error("Preview readiness is unavailable");
  } catch (error: unknown) {
    try { if (admissionAttempted) await control.stopOwned(request); else await control.stopRequest(request); }
    catch (cleanupError: unknown) { console.warn("[preview-pair] recovery remains pending", cleanupError instanceof Error ? cleanupError.name : "UnknownError"); }
    console.warn("[preview-pair] build handoff unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Preview build handoff is unavailable");
  }
}
