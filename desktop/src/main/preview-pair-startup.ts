import type { BuildSource } from "@matrix-os/contracts";
import { verifyDesktopPreviewContext } from "./preview-pair-context";
import { verifyPreviewPairProfile } from "./preview-pair-profiles";
import type { VerifiedDesktopPreviewContext } from "./preview-pair-context";
export interface PreviewStartupApp { setName(value: string): void; setPath(name: "userData" | "sessionData", value: string): void }
/** Main awaits this at module top level. Electron must not emit ready or select
 * its singleton/session paths while Source/ownership verification is pending. */
export async function initializeDesktopPreview(app: PreviewStartupApp, env: NodeJS.ProcessEnv, options: {
  buildSource: BuildSource | null; home?: string; platform?: string; arch?: string; now?: () => number; fetchFn?: typeof fetch;
}): Promise<VerifiedDesktopPreviewContext | null> {
  const context = await verifyDesktopPreviewContext(env.MATRIX_PREVIEW_PAIR_CONTEXT, options);
  if (!context) return null;
  const paths = await verifyPreviewPairProfile(context, env.OPERATOR_USER_DATA_DIR, options.home);
  app.setName(`Matrix OS Preview (${context.role === "owner" ? "Owner" : "Member"})`);
  app.setPath("userData", paths.userData); app.setPath("sessionData", paths.sessionData);
  return context;
}
