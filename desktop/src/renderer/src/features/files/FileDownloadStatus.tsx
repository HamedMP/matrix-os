import type { FileDownloadController } from "@matrix-os/ui";
import { Button } from "../../design/primitives";

export function FileDownloadStatus({ download }: { download: FileDownloadController }) {
  if (!download.message) return null;
  return (
    <div className="ph-no-capture flex shrink-0 items-center gap-3 border-t px-4 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: download.error ? "var(--danger)" : "var(--text-secondary)" }}>
      <div role={download.error ? "alert" : "status"} className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={download.filename}>{download.filename}</span>
        <span>{download.message}</span>
      </div>
      {download.pending
        ? <Button variant="ghost" onClick={download.cancel} aria-label="Cancel download">Cancel</Button>
        : <Button variant="ghost" onClick={download.dismiss} aria-label="Dismiss download status">Dismiss</Button>}
    </div>
  );
}
