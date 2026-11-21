import {
  FileResourceRefSchema,
  MAX_AGENT_ATTACHMENT_BYTES,
  type FileResourceRef,
} from "@matrix-os/contracts";
import { filePreviewContentUrl } from "@matrix-os/ui";
import type { ApiClient } from "../../../lib/api";
import { useConnection } from "../../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";

export const MATRIX_FILE_DRAG_TYPE = "application/x-matrix-file-attachment";
export type MatrixAttachmentResource = Exclude<FileResourceRef, { kind: "artifact" }>;

let activeDrag: {
  token: string;
  resource: MatrixAttachmentResource;
  connection: ReturnType<typeof captureAttachmentConnection>;
  expires: number;
} | null = null;

export function captureAttachmentConnection() {
  const { api, runtimeSlot, authGeneration } = useConnection.getState();
  const generation = captureRuntimeGeneration();
  return {
    runtimeSlot,
    isCurrent: () => {
      const current = useConnection.getState();
      return isCurrentRuntimeGeneration(generation) && current.api === api
        && current.runtimeSlot === runtimeSlot && current.authGeneration === authGeneration;
    },
  };
}

export function beginMatrixFileDrag(
  dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  resource: MatrixAttachmentResource,
  connection = captureAttachmentConnection(),
) {
  endMatrixFileDrag();
  if (!connection.isCurrent()) return;
  const parsed = FileResourceRefSchema.safeParse(resource);
  if (!parsed.success || parsed.data.kind === "artifact") return;
  const token = crypto.randomUUID();
  dataTransfer.setData(MATRIX_FILE_DRAG_TYPE, token);
  dataTransfer.effectAllowed = "copy";
  activeDrag = { token, resource: parsed.data, connection, expires: Date.now() + 120_000 };
}

export function endMatrixFileDrag() {
  activeDrag = null;
}

export function takeMatrixFileDrag(dataTransfer: Pick<DataTransfer, "getData">): MatrixAttachmentResource | null {
  const drag = activeDrag;
  if (!drag || dataTransfer.getData(MATRIX_FILE_DRAG_TYPE) !== drag.token) return null;
  endMatrixFileDrag();
  return Date.now() < drag.expires && drag.connection.isCurrent() ? drag.resource : null;
}

export async function readMatrixFileAttachment(api: Pick<ApiClient, "getBlob">, resource: MatrixAttachmentResource, signal: AbortSignal) {
  const parsed = FileResourceRefSchema.parse(resource);
  if (parsed.kind === "artifact") throw new Error("Attachment unavailable");
  const name = parsed.path.split("/").at(-1)!;
  if (name.length > 255 || /[\\\u0000-\u001f\u007f]/.test(name)) throw new Error("Attachment unavailable");
  signal.throwIfAborted();
  const blob = await api.getBlob(filePreviewContentUrl(parsed, { download: true }), { maxBytes: MAX_AGENT_ATTACHMENT_BYTES, signal });
  signal.throwIfAborted();
  if (blob.size > MAX_AGENT_ATTACHMENT_BYTES) throw new Error("file_too_large");
  return new File([blob], name, { type: blob.type.split(";")[0] });
}
