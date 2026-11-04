import { verifyDesktopPreviewContext } from "@desktop/main/preview-pair-context";
import { issuePreviewPairLaunch, verifyPreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { PAIR_NOW, previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
/** Real descriptor producer/crypto/consumer, synthetic Source HTTP/current-state. */
export async function verifiedPreviewPairTestContext(role: "owner" | "member" = "owner") {
  const secret = "s".repeat(40), proof = issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role,
    platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, secret, PAIR_NOW);
  return (await verifyDesktopPreviewContext(JSON.stringify(proof), { buildSource: { commit: proof.context.sourceSha, ancestors: [] },
    platform: "darwin", arch: "arm64", now: () => PAIR_NOW, fetchFn: async (_url, init) => verifyPreviewPairLaunch(JSON.parse(String(init?.body)), secret, PAIR_NOW)
      ? Response.json({ valid: true }) : new Response(null, { status: 404 }) }))!;
}
