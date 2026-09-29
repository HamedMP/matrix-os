import { useCallback, useEffect, useRef, useState } from "react";
import { FilePreviewDescriptorSchema, type FilePreviewDescriptor } from "@matrix-os/contracts";
import { FilePreviewContent, FilePreviewActions, copyFileImage, savePreviewBlob, filePreviewContentUrl, filePreviewMetadataUrl } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { useDesktopFileDownload } from "../files/use-file-download";
import type { InspectorFileTarget } from "./InspectorFilesPanel";

const MAX_PROJECT_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const PROJECT_TEXT_PREFIX_BYTES = 64 * 1024;

export function InspectorResourcePreview({ target }: { target: InspectorFileTarget }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const download = useDesktopFileDownload();
  const [attempt, setAttempt] = useState(0);
  const [descriptor, setDescriptor] = useState<FilePreviewDescriptor | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const resource = target.kind === "home" ? { kind: "home" as const, path: target.path }
    : { kind: "project" as const, projectId: target.projectId, path: target.path, ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}) };
  const metadataUrl = filePreviewMetadataUrl(resource);
  const isCurrent = useCallback(() => {
    const current = useConnection.getState();
    return mounted.current && current.runtimeSlot === runtimeSlot && current.authGeneration === authGeneration;
  }, [runtimeSlot, authGeneration]);
  useEffect(() => {
    const controller = new AbortController();
    setDescriptor(null);
    setFailed(false);
    if (!api) return () => controller.abort();
    void api.forRuntime(runtimeSlot).get<unknown>(metadataUrl, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted && isCurrent()) setDescriptor(FilePreviewDescriptorSchema.parse(value));
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[chat-file] metadata failed", error instanceof Error ? error.name : "UnknownError");
      if (isCurrent()) setFailed(true);
    });
    return () => controller.abort();
  }, [api, metadataUrl, attempt, runtimeSlot, isCurrent]);
  const loadBlob = useCallback(async (url: string, maxBytes: number) => {
    if (!api || !isCurrent()) throw new Error("PreviewUnavailable");
    const blob = await api.forRuntime(runtimeSlot).getBlob(url, { maxBytes });
    if (!isCurrent()) throw new Error("PreviewUnavailable");
    return blob;
  }, [api, runtimeSlot, isCurrent]);
  const textPrefix = target.kind === "project" && descriptor && ["text", "markdown"].includes(descriptor.kind) && descriptor.sizeBytes > 1024 * 1024;
  const loadText = useCallback(async (url: string, maxBytes: number) => {
    if (!textPrefix) return (await loadBlob(url, maxBytes)).text();
    if (!api || !isCurrent()) throw new Error("PreviewUnavailable");
    const text = await api.forRuntime(runtimeSlot).getText(url, { maxBytes, headers: { Range: `bytes=0-${maxBytes - 1}` } });
    if (!isCurrent()) throw new Error("PreviewUnavailable");
    return text;
  }, [api, isCurrent, loadBlob, runtimeSlot, textPrefix]);
  if (!descriptor) return <div className="p-4 text-xs" role={failed ? "alert" : "status"}>
    {failed ? <>File preview unavailable. <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></> : "Loading preview…"}
  </div>;
  const contentUrl = filePreviewContentUrl(descriptor.resource);
  const projectDownloadTooLarge = target.kind === "project" && descriptor.sizeBytes > MAX_PROJECT_DOWNLOAD_BYTES;
  const onDownload = descriptor.canDownload && !projectDownloadTooLarge ? async () => {
    if (!isCurrent()) throw new Error("PreviewUnavailable");
    if (target.kind === "home") { download.download(target.path); return; }
    const blob = await loadBlob(filePreviewContentUrl(descriptor.resource, { download: true }), MAX_PROJECT_DOWNLOAD_BYTES);
    if (isCurrent()) savePreviewBlob(blob, descriptor.name);
  } : undefined;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
      <span className="min-w-0 truncate text-xs">{descriptor.name}</span>
      <FilePreviewActions key={contentUrl} name={descriptor.name} onDownload={onDownload} pending={download.pending}
        onCopyImage={descriptor.kind === "image" ? async () => copyFileImage(await loadBlob(contentUrl, 50 * 1024 * 1024), isCurrent) : undefined} />
      {download.message ? <span role={download.error ? "alert" : "status"} className="text-xs">{download.message}</span> : null}
      {projectDownloadTooLarge ? <p className="text-xs">Project downloads are available for files up to 50 MiB.</p> : null}
    </header>
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <FilePreviewContent key={`${contentUrl}:${attempt}`} descriptor={descriptor} contentUrl={contentUrl} loadBlob={loadBlob} loadText={loadText} textPreviewBytes={textPrefix ? PROJECT_TEXT_PREFIX_BYTES : undefined} retry={() => setAttempt((value) => value + 1)} />
    </div>
  </div>;
}
