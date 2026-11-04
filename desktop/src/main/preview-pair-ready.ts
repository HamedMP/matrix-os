import { connect } from "node:net";
import { z } from "zod/v4";
import { PreviewPairLaunchContextSchema, type PreviewPairLaunchContext } from "@matrix-os/contracts/preview-pair-launch";
const shape = PreviewPairLaunchContextSchema.shape;
export const PreviewPairReadySchema = z.strictObject({ nonce: shape.nonce, pairId: shape.pairId, generation: shape.generation,
  role: shape.role, sourceSha: shape.sourceSha, machineId: shape.machineId, pid: z.number().int().positive() });
export function previewReadyMessage(context: PreviewPairLaunchContext, pid = process.pid) {
  return PreviewPairReadySchema.parse({ nonce: context.nonce, pairId: context.pairId, generation: context.generation,
    role: context.role, sourceSha: context.sourceSha, machineId: context.machineId, pid });
}
/** Local startup acknowledgement only; carries no session/credential and grants
 * no access. The descriptor has already passed actual Source verification. */
export async function acknowledgePreviewDesktop(context: PreviewPairLaunchContext, rawPort: string | undefined) {
  if (!rawPort || !/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error("Preview launcher is unavailable");
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(rawPort) });
    socket.setTimeout(5_000); socket.once("timeout", () => socket.destroy(new Error("Preview launcher timed out")));
    socket.once("error", reject); socket.once("connect", () => socket.end(JSON.stringify(previewReadyMessage(context)) + "\n"));
    socket.once("close", hadError => { if (!hadError) resolve(); });
  });
}
