import { FolderOpen, HardDrive } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "./ComputerFileBrowser";
import { FilePreview, resolveActivePath, type FileSelection } from "./FilePreviewPane";

// Re-exported so existing consumers (and tests) keep a stable import site.
export { resolveActivePath } from "./FilePreviewPane";
export type { FileSelection } from "./FilePreviewPane";

export default function FilesWorkspace() {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [selection, setSelection] = useState<FileSelection | null>(null);

  // Correctness comes from this synchronous derivation, not the effect below:
  // a selection made under another computer/session resolves to null on the
  // first render with the new slot or generation, so FilePreview never sees a
  // stale path.
  const activePath = resolveActivePath(selection, runtimeSlot, authGeneration);

  useEffect(() => {
    setSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [runtimeSlot, authGeneration]);

  const handleOpenFile = useCallback(
    (path: string) => setSelection({ slot: runtimeSlot, authGeneration, path }),
    [runtimeSlot, authGeneration],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-app)" }}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-5" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}><FolderOpen size={17} /></span>
          <div>
            <h1 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Files</h1>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Browse and preview your Matrix computer</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
          <HardDrive size={13} />
          <span>{handle ?? "Matrix computer"}</span>
          {runtimeSlot !== "primary" ? <span>· {runtimeSlot}</span> : null}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(220px,40%)_minmax(0,1fr)] gap-3 p-3 md:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] md:grid-rows-1">
        <ComputerFileBrowser onOpenFile={handleOpenFile} />
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border" style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}>
          <div className="flex h-10 shrink-0 items-center border-b px-3 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            <span className="truncate" title={activePath ?? undefined}>{activePath ?? "Preview"}</span>
          </div>
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}>
            <FilePreview path={activePath} />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
