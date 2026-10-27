import { useCallback, useEffect, useRef, useState } from "react";
import { FilePreviewDescriptorSchema, type FilePreviewDescriptor } from "@matrix-os/contracts";
import { FilePreviewContent, FilePreviewActions, copyFileImage, savePreviewBlob, filePreviewContentUrl, filePreviewMetadataUrl } from "@matrix-os/ui";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useDesktopFileDownload } from "../files/use-file-download";
import type { InspectorFileTarget } from "./InspectorFilesPanel";
import { DesktopFilePreviewContent, DesktopFilePreviewViewport } from "../files/DesktopFilePreviewContent";
import { openResourceInDesktopEditor } from "../editor/desktop-editor-store";
import { useFilesNavigation } from "../../stores/files-navigation";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";

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
  const [editError, setEditError] = useState(false);
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
  return <FilePreviewActions key={contentUrl} name={descriptor.name} onDownload={onDownload} pending={download.pending} zIndex={DESKTOP_Z_INDEX.popover}
    onCopyPath={async () => { if (!isCurrent()) throw new Error("PreviewUnavailable"); await navigator.clipboard.writeText(target.path); }}
    onOpenInFiles={() => {
      if (!isCurrent()) throw new Error("PreviewUnavailable");
      if (target.kind === "project") useFilesNavigation.getState().navigateProject({ kind: "project", projectId: target.projectId, worktreeId: target.worktreeId, path: target.path }, false);
      else useFilesNavigation.getState().navigate(target.path.split("/").slice(0, -1).join("/"));
      const tabId = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
      useDesktopSurfaces.getState().activateSurface(tabId);
    }}
    onCopyImage={descriptor.kind === "image" ? async () => copyFileImage(await loadBlob(contentUrl, 50 * 1024 * 1024), isCurrent) : undefined}>
    <div className="flex min-h-0 flex-1 flex-col" tabIndex={0} aria-label={`File preview ${descriptor.name}`}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
      <span className="min-w-0 truncate text-xs">{descriptor.name}</span>
      {["markdown", "text", "html"].includes(descriptor.kind) ? <button type="button" aria-label={`Edit ${descriptor.name}`} className="rounded px-2 py-1 text-xs hover:bg-[var(--bg-hover)]" onClick={() => {
        if (!isCurrent()) return;
        setEditError(false);
        void openResourceInDesktopEditor(resource, isCurrent).then((opened) => {
          if (!isCurrent()) return;
          if (!opened) { setEditError(true); return; }
          const id = useTabs.getState().activeTabId;
          if (id) useDesktopSurfaces.getState().activateSurface(id);
        }).catch((error: unknown) => { console.warn("[file-preview] editor unavailable", error instanceof Error ? error.name : "UnknownError"); if (isCurrent()) setEditError(true); });
      }}>Edit</button> : null}
      {editError ? <span role="alert" className="text-xs">Could not open Editor. Try again.</span> : null}
      {download.message ? <span role={download.error ? "alert" : "status"} className="text-xs">{download.message}</span> : null}
      {projectDownloadTooLarge ? <p className="text-xs">Project downloads are available for files up to 50 MiB.</p> : null}
    </header>
    <DesktopFilePreviewViewport kind={descriptor.kind}>
      <DesktopFilePreviewContent key={`${contentUrl}:${attempt}`} descriptor={descriptor} contentUrl={contentUrl} loadBlob={loadBlob} loadText={loadText} textPreviewBytes={textPrefix ? PROJECT_TEXT_PREFIX_BYTES : undefined} retry={() => setAttempt((value) => value + 1)} />
    </DesktopFilePreviewViewport>
  </div></FilePreviewActions>;
}
