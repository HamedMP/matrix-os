import type { ReactNode, Ref } from "react";

/** The grid view: one listbox with a labelled group per section (Folders, Files). */
export function FileGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="listbox" aria-label={label} aria-multiselectable="true" className="flex flex-col gap-6 font-ds-sans">
      {children}
    </div>
  );
}

export const FILE_GRID_TEMPLATE = "grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-3";

export function FileGridSection({ title, count, gridRef, children }: { title: string; count: number; gridRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  const id = `files-section-${title.toLowerCase()}`;
  return (
    <div role="group" aria-labelledby={id}>
      <h3 id={id} className="mb-2 flex items-center gap-2 text-ds-cap font-medium tracking-[0.06em] text-ds-muted-foreground uppercase">
        {title}
        <span className="font-normal tabular-nums normal-case">{count}</span>
      </h3>
      <div ref={gridRef} className={FILE_GRID_TEMPLATE}>{children}</div>
    </div>
  );
}
