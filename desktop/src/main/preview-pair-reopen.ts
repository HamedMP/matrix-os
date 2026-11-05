import { z } from "zod/v4";
import type { BuildSource } from "@matrix-os/contracts";
import { verifyDesktopPreviewContext, type VerifiedDesktopPreviewContext } from "./preview-pair-context";
import { acknowledgePreviewDesktop } from "./preview-pair-ready";
const Request = z.strictObject({ proof: z.string().max(16_384), port: z.string().regex(/^[0-9]{1,5}$/) });
export async function acknowledgeReopenedPreview(current: VerifiedDesktopPreviewContext, raw: unknown, buildSource: BuildSource | null,
  prepareWindow: () => Promise<void>) {
  const request = Request.parse(raw), next = await verifyDesktopPreviewContext(request.proof, { buildSource });
  if (!next) throw new Error("Preview reopen is unavailable");
  for (const key of ["pairId", "generation", "sourceSha", "role", "actorId", "machineId", "organizationId", "apiOrigin", "runtimeSlot", "authorityGeneration"] as const) {
    if (current[key] !== next[key]) throw new Error("Preview reopen is unavailable");
  }
  await prepareWindow();
  await acknowledgePreviewDesktop(next, request.port);
}
