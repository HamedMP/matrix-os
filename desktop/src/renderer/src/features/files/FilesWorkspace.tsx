import { Suspense, useCallback, useEffect, useState } from "react";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser, { type BrowserSelection } from "./ComputerFileBrowser";
import { PreviewPane, resolveActivePath, type FileSelection } from "./FilePreviewPane";

// Re-exported so existing consumers (and tests) keep a stable import site.
export { resolveActivePath } from "./FilePreviewPane";
export type { FileSelection } from "./FilePreviewPane";

export default function FilesWorkspace() {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [selection, setSelection] = useState<FileSelection | null>(null);

  // Correctness comes from this synchronous derivation, not the effect below:
  // a selection made under another computer/session resolves to null on the
  // first render with the new slot or generation, so FilePreview never sees a
  // stale path.
  const activePath = resolveActivePath(selection, runtimeSlot, authGeneration);
  const activeSelection = activePath !== null && selection?.entry
    ? { path: activePath, entry: selection.entry }
    : null;

  useEffect(() => {
    setSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [runtimeSlot, authGeneration]);

  const handleSelectionChange = useCallback(
    (next: BrowserSelection | null) => setSelection(next
      ? { slot: runtimeSlot, authGeneration, path: next.path, entry: next.entry }
      : null),
    [runtimeSlot, authGeneration],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-surface)" }}>
      <h1 className="sr-only">Files</h1>
      <div
        data-testid="files-workspace-panes"
        data-layout={activeSelection ? "split" : "overview"}
        className={`grid min-h-0 flex-1 grid-cols-1 overflow-hidden ${activeSelection
          ? "grid-rows-[minmax(220px,40%)_minmax(0,1fr)] md:grid-cols-[minmax(300px,2fr)_minmax(0,3fr)] md:grid-rows-1"
          : "grid-rows-1"}`}
        style={{ background: "var(--bg-surface)" }}
      >
        <div
          data-testid="files-home-content"
          className={activeSelection
            ? "contents"
            : "mx-auto flex min-h-0 w-full max-w-[1052px] flex-col px-4 pt-4"}
        >
          <ComputerFileBrowser onSelectionChange={handleSelectionChange} framed={false} />
        </div>
        {activeSelection ? (
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}>
            <PreviewPane selection={activeSelection} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
