import { FileCode2, FolderTree, X } from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import { Button, Dialog, EmptyState } from "../../design/primitives";
import RetainedPane from "../../design/RetainedPane";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "../files/ComputerFileBrowser";
import MonacoEditorHost from "./MonacoEditorHost";
import {
  currentDesktopEditorScope,
  useDesktopEditor,
} from "./desktop-editor-store";

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export default function DesktopEditorWorkspace() {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const paths = useDesktopEditor((state) => state.paths);
  const activePath = useDesktopEditor((state) => state.activePath);
  const dirtyPaths = useDesktopEditor((state) => state.dirtyPaths);
  const error = useDesktopEditor((state) => state.error);
  const ensureScope = useDesktopEditor((state) => state.ensureScope);
  const openFile = useDesktopEditor((state) => state.openFile);
  const setActive = useDesktopEditor((state) => state.setActive);
  const setDirty = useDesktopEditor((state) => state.setDirty);
  const closeFile = useDesktopEditor((state) => state.closeFile);
  const clearError = useDesktopEditor((state) => state.clearError);
  const [discardPath, setDiscardPath] = useState<string | null>(null);

  useEffect(() => {
    ensureScope(currentDesktopEditorScope());
    setDiscardPath(null);
  }, [authGeneration, ensureScope, runtimeSlot]);

  const requestClose = (path: string) => {
    if (dirtyPaths.includes(path)) setDiscardPath(path);
    else closeFile(path);
  };

  return (
    <div className="flex min-h-0 flex-1" style={{ background: "var(--bg-surface)" }}>
      <h1 className="sr-only">Editor</h1>
      <aside
        aria-label="Editor files"
        className="flex w-[280px] min-w-[220px] max-w-[34%] shrink-0 flex-col border-r"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs font-semibold" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          <FolderTree size={14} aria-hidden /> Matrix home
        </div>
        <ComputerFileBrowser
          compact
          forceList
          framed={false}
          fillAvailableHeight
          onOpenFile={openFile}
        />
      </aside>
      <section aria-label="Editor workspace" className="flex min-w-0 flex-1 flex-col">
        <div role="tablist" aria-label="Open editor files" className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-app)" }}>
          {paths.map((path) => {
            const active = path === activePath;
            const dirty = dirtyPaths.includes(path);
            return (
              <div key={path} className="flex h-8 shrink-0 items-center rounded-t-lg border border-b-0" style={{ borderColor: "var(--border-subtle)", background: active ? "var(--bg-surface)" : "transparent" }}>
                <button type="button" role="tab" aria-selected={active} aria-label={basename(path)} title={path} onClick={() => setActive(path)} className="flex h-full max-w-56 items-center gap-2 px-3 text-xs outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]" style={{ color: active ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                  <FileCode2 size={13} aria-hidden />
                  <span className="truncate">{basename(path)}</span>
                  {dirty ? <span aria-label="Unsaved" className="size-1.5 shrink-0 rounded-full bg-[var(--accent)]" /> : null}
                </button>
                <button type="button" aria-label={`Close ${basename(path)}`} onClick={() => requestClose(path)} className="mr-1 flex size-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><X size={12} /></button>
              </div>
            );
          })}
        </div>
        {error ? (
          <div role="alert" className="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--danger)" }}>
            <span>{error}</span><Button variant="ghost" onClick={clearError}>Dismiss</Button>
          </div>
        ) : null}
        <div className="relative flex min-h-0 flex-1">
          {paths.length === 0 ? (
            <EmptyState icon={<FileCode2 size={28} />} headline="Choose a file to start editing." description="Open a file from Matrix home, Files, or Chat. Changes save back to the selected computer." />
          ) : paths.map((path) => {
            const active = path === activePath;
            return (
              <RetainedPane key={path} active={active} visible={active}>
                <MonacoEditorHost
                  path={path}
                  active={active}
                  onDirtyChange={(dirty) => setDirty(path, dirty)}
                />
              </RetainedPane>
            );
          })}
        </div>
      </section>
      <Dialog open={discardPath !== null} onClose={() => setDiscardPath(null)} title="Discard unsaved changes?" width={420} placement="center">
        <div className="p-5">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Discard unsaved changes?</h2>
          <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>{discardPath ? basename(discardPath) : "This file"} has changes that have not been saved.</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDiscardPath(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => {
              if (discardPath) closeFile(discardPath);
              setDiscardPath(null);
            }}>Discard</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
