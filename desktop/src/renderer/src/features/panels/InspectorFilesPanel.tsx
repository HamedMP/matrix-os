import { Suspense, useCallback, useEffect, useState } from "react";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "../files/ComputerFileBrowser";
import { FilePreview, resolveActivePath, type FileSelection } from "../files/FilePreviewPane";

/**
 * Inspector Files surface: the shared computer file browser in compact mode
 * on top, the shared bounded preview (1 MB text / 10 MB image, markdown
 * rendered) below. Selection is scoped to the current computer/session so a
 * runtime switch can never preview another owner's path.
 */
export function InspectorFilesPanel() {
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [selection, setSelection] = useState<FileSelection | null>(null);

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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="shrink-0">
        <ComputerFileBrowser compact onOpenFile={handleOpenFile} />
      </div>
      <section
        aria-label="File preview"
        className="flex min-h-[180px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border"
        style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
      >
        <div
          className="flex h-8 shrink-0 items-center border-b px-2.5 text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          <span className="truncate" title={activePath ?? undefined}>{activePath ?? "Preview"}</span>
        </div>
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>
              Loading preview…
            </div>
          }
        >
          <FilePreview path={activePath} />
        </Suspense>
      </section>
    </div>
  );
}
