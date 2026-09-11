import { useCallback, useEffect, useRef, useState } from "react";
import {
  DownloadPathSchema, FileDownloadResultSchema,
  fileDownloadMessage, safeDownloadFilename, type FileDownloadResult,
} from "@matrix-os/contracts";

export type FileDownloadTransport = (input: {
  path: string; requestId: string; signal: AbortSignal;
}) => Promise<FileDownloadResult>;
interface DownloadState {
  scope: string;
  filename: string;
  pending: boolean;
  result?: FileDownloadResult;
}

// Shared presentation state; each host owns only transport and local-save UX.
// One active request and one visible outcome, with no unbounded download history.
export function useFileDownload(scope: string, transport: FileDownloadTransport) {
  const [state, setState] = useState<DownloadState | null>(null);
  const active = useRef<{ controller: AbortController; scope: string } | null>(null);
  useEffect(() => () => {
    active.current?.controller.abort();
    active.current = null;
  }, [scope]);

  const download = useCallback((path: string, _size?: number) => {
    if (active.current) return;
    const filename = safeDownloadFilename(path);
    if (!DownloadPathSchema.safeParse(path).success) {
      setState({ scope, filename, pending: false, result: { status: "error", code: "unavailable" } });
      return;
    }
    const request = { controller: new AbortController(), scope };
    active.current = request;
    setState({ scope, filename, pending: true });
    void Promise.resolve().then(() => {
      request.controller.signal.throwIfAborted();
      return transport({ path, requestId: crypto.randomUUID(), signal: request.controller.signal });
    }).then((result) => {
      const parsed = FileDownloadResultSchema.safeParse(result);
      return parsed.success ? parsed.data : { status: "error", code: "failed" } as const;
    }).catch((): FileDownloadResult => ({ status: "error", code: "failed" }))
      .then((result) => {
        if (active.current !== request) return;
        active.current = null;
        setState({ scope, filename, pending: false, result: request.controller.signal.aborted && result.status !== "saved" && result.status !== "handed_off" ? { status: "cancelled" } : result });
      });
  }, [scope, transport]);

  const visible = state?.scope === scope ? state : null;
  return {
    download,
    pending: visible?.pending ?? false,
    filename: visible?.filename ?? "",
    message: visible?.pending ? "Downloading…" : visible?.result ? fileDownloadMessage(visible.result) : "",
    error: visible?.result?.status === "error",
    cancel: useCallback(() => { active.current?.controller.abort(); }, []),
    dismiss: useCallback(() => { if (!active.current) setState(null); }, []),
  };
}
export type FileDownloadController = ReturnType<typeof useFileDownload>;
