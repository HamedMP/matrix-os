import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { FilePreviewActions, filePreviewContentUrl, filePreviewMetadataUrl, savePreviewBlob } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { useFilesNavigation } from "../../stores/files-navigation";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../stores/tabs";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useDesktopFileDownload } from "./use-file-download";
import type { WorkFilesScope } from "../work/work-files-scope";
import type { InspectorTreeEntry } from "../panels/ExpandableFileTree";
import { DESKTOP_Z_INDEX } from "../../design/layering";

export function useInspectorFileActions(scope: Exclude<WorkFilesScope, { kind: "unavailable" }>) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const download = useDesktopFileDownload();
  const mounted = useRef(false);
  const archiveController = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; archiveController.current?.abort(); };
  }, [runtimeSlot, authGeneration]);
  const current = useCallback(() => {
    const value = useConnection.getState();
    return mounted.current && value.api === api && value.runtimeSlot === runtimeSlot && value.authGeneration === authGeneration;
  }, [api, runtimeSlot, authGeneration]);
  const assertCurrent = () => { if (!current()) throw new Error("FilesUnavailable"); };
  const resource = (path: string) => scope.kind === "home" ? { kind: "home" as const, path }
    : { kind: "project" as const, projectId: scope.projectId, worktreeId: scope.worktreeId, path };
  const read = async (path: string, maxBytes: number, signal: AbortSignal) => {
    assertCurrent();
    if (!api) throw new Error("FilesUnavailable");
    const blob = await api.forRuntime(runtimeSlot).getBlob(filePreviewContentUrl(resource(path), { download: true }), { maxBytes, signal });
    assertCurrent();
    return new Uint8Array(await blob.arrayBuffer());
  };
  const renderEntry = (entry: InspectorTreeEntry, button: ReactElement) => <FilePreviewActions name={entry.path.split("/").at(-1)!} pending={download.pending} zIndex={DESKTOP_Z_INDEX.popover}
    onCopyPath={async () => { assertCurrent(); await navigator.clipboard.writeText(entry.path); }}
    onOpenInFiles={() => {
      assertCurrent();
      if (scope.kind === "project") {
        useFilesNavigation.getState().navigateProject({ kind: "project", projectId: scope.projectId, worktreeId: scope.worktreeId, path: entry.path }, entry.kind === "directory");
      } else useFilesNavigation.getState().navigate(entry.kind === "directory" ? entry.path : entry.path.split("/").slice(0, -1).join("/"));
      const id = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
      useDesktopSurfaces.getState().activateSurface(id);
    }}
    onDownload={async () => {
      assertCurrent();
      if (entry.kind === "file" && scope.kind === "home") { download.download(entry.path); return; }
      if (archiveController.current) throw new Error("DownloadBusy");
      const controller = new AbortController();
      archiveController.current = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      try {
        if (entry.kind === "directory") {
          const { createDirectoryArchive, parseArchiveListing } = await import("./directory-download");
          const archive = await createDirectoryArchive(entry.path, {
            list: async (path, listSignal) => {
              assertCurrent();
              if (!api) throw new Error("FilesUnavailable");
              const url = filePreviewMetadataUrl(resource(path)).replace("/metadata?", "/directory?");
              const response = await api.forRuntime(runtimeSlot).get<unknown>(url, { signal: listSignal });
              assertCurrent();
              return parseArchiveListing(response);
            }, read,
          }, signal);
          assertCurrent(); signal.throwIfAborted();
          savePreviewBlob(new Blob([new Uint8Array(archive.bytes)], { type: "application/zip" }), archive.name);
        } else {
          const bytes = await read(entry.path, 50 * 1024 * 1024, signal);
          assertCurrent(); signal.throwIfAborted();
          savePreviewBlob(new Blob([new Uint8Array(bytes)]), entry.path.split("/").at(-1)!);
        }
      } finally { if (archiveController.current === controller) archiveController.current = null; }
    }}>
    {button}
  </FilePreviewActions>;
  return { renderEntry, download };
}
