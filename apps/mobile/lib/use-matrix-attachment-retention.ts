import { useLayoutEffect } from "react";
import { retainMatrixAttachmentUris } from "@/lib/matrix-attachment-retention";

/** Release cache ownership when a composer drops a file or unmounts. */
export function useMatrixAttachmentRetention(uris: readonly string[]) {
  useLayoutEffect(() => retainMatrixAttachmentUris(uris), [uris]);
}
