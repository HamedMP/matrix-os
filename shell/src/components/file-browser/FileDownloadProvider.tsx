"use client";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { useFileDownload, type FileDownloadController } from "@matrix-os/ui";
import { DownloadIcon } from "@/lib/hugeicons";
import { getGatewayUrl } from "@/lib/gateway";
import { createBrowserFileDownload } from "@/lib/file-download";
import { Button } from "@/components/ui/button";

const DownloadContext = createContext<FileDownloadController | null>(null);
export const useWebFileDownload = () => useContext(DownloadContext);

export function FileDownloadProvider({ children }: { children: ReactNode }) {
  const { userId, sessionId } = useAuth();
  const gateway = getGatewayUrl();
  const scope = `${gateway}|${userId ?? ""}|${sessionId ?? ""}`;
  const client = useMemo(() => createBrowserFileDownload(gateway), [gateway, scope]);
  useEffect(() => () => client.dispose(), [client, scope]);
  const download = useFileDownload(scope, client.download);
  return (
    <DownloadContext.Provider value={download}>
      {children}
      {download.message ? (
        <div className={`ph-no-capture flex shrink-0 items-center gap-3 border-t px-3 py-2 text-xs ${download.error ? "text-destructive" : "text-muted-foreground"}`}>
          <div role={download.error ? "alert" : "status"} className="min-w-0 flex-1">
            <span className="block truncate font-medium" title={download.filename}>{download.filename}</span>
            <span>{download.message}</span>
          </div>
          {download.pending
            ? <Button variant="ghost" size="sm" aria-label="Cancel download" onClick={download.cancel}>Cancel</Button>
            : <Button variant="ghost" size="sm" aria-label="Dismiss download status" onClick={download.dismiss}>Dismiss</Button>}
        </div>
      ) : null}
    </DownloadContext.Provider>
  );
}

export function FileDownloadAction({ path, size }: { path: string; size?: number }) {
  const download = useWebFileDownload();
  if (!download) return null;
  return <Button variant="ghost" size="sm" disabled={download.pending} onClick={() => download.download(path, size)}><DownloadIcon className="size-4" />Download</Button>;
}
