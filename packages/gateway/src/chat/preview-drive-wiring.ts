import { createHash } from "node:crypto";
import { canonicalPreviewDriveTurnBody, type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import type { MatrixMcpCapabilityRegistry } from "./matrix-mcp-launch.js";
import type { PreviewDrivePlatformClient } from "./preview-drive-platform-client.js";

export function createPreviewDriveWiring(options: {
  previewRuntime: boolean;
  registry: Pick<MatrixMcpCapabilityRegistry, "authorizePreviewDriveRun">;
  client?: Pick<PreviewDrivePlatformClient, "redeemTurn" | "revoke">;
}) {
  if (!options.previewRuntime || !options.client) return { beforeDispatch: undefined, client: undefined };
  const client = options.client;
  return { client, async beforeDispatch(input: { actorId: string; chatId: string; turnId: string; runId: string;
    clientRequestId: string; body: CanonicalCreateChatTurnRequest; proof: string }) {
    if (!input.proof || input.proof.length > 2_000) throw new Error("Preview Drive turn proof unavailable");
    const bodyDigest = createHash("sha256").update(canonicalPreviewDriveTurnBody(input.body)).digest("hex");
    const runGrant = await client.redeemTurn({ actorId: input.actorId, chatId: input.chatId,
      turnId: input.turnId, runId: input.runId, clientRequestId: input.clientRequestId,
      bodyDigest, proof: input.proof });
    const scope = { runGrant, chatId: input.chatId, runId: input.runId };
    const revoke = () => { void client.revoke(scope).catch(error => {
      console.warn("[chat] Preview Drive run revocation failed", error instanceof Error ? error.name : "UnknownError");
    }); };
    if (!options.registry.authorizePreviewDriveRun({ actorId: input.actorId, chatId: input.chatId,
      runId: input.runId, runGrant, onRevoke: revoke })) {
      revoke();
      throw new Error("Preview Drive run unavailable");
    }
  } };
}
