import { useCallback } from "react";
import { useFileDownload, type FileDownloadTransport } from "@matrix-os/ui";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";

export function useDesktopFileDownload() {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const platformHost = useConnection((state) => state.platformHost);
  const transport = useCallback<FileDownloadTransport>(async ({ path, requestId, signal }) => {
    signal.throwIfAborted();
    const cancel = () => {
      void invoke("runtime:cancel-file-download", { requestId }).catch(() => {
        console.warn("[file-download] could not request cancellation");
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await invoke("runtime:download-file", { path, requestId, runtimeSlot, authGeneration });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }, [runtimeSlot, authGeneration]);
  return useFileDownload(`${platformHost}|${runtimeSlot}|${authGeneration}`, transport);
}
