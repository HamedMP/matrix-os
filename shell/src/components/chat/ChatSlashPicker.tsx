import type { CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";
import { chatSlashStatusMessage, filterCanonicalSlashEntries, listCanonicalSlashEntries, useProjectChatSlashSkills, type CanonicalSlashEntry, type ProjectChatSlashScope } from "@matrix-os/ui";
import { useCallback, useEffect } from "react";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

export function ChatSlashPicker({instance,loading,query,projectSlash,listRef,anchorRef,inputRef,onSelect,onDismiss,onOutsideDismiss}: {
  instance?: CanonicalProviderInstanceDescriptor; loading:boolean; query:string|null; projectSlash?:ProjectChatSlashScope;
  listRef: React.RefObject<HTMLDivElement|null>; anchorRef: React.RefObject<HTMLDivElement|null>;
  inputRef: React.RefObject<HTMLTextAreaElement|null>;
  onSelect(entry:CanonicalSlashEntry):void; onDismiss():void; onOutsideDismiss():void;
}) {
  const projectSkills = useProjectChatSlashSkills(projectSlash, query !== null);
  useEffect(() => {
    if (query === null) return;
    const ownerDocument = anchorRef.current?.ownerDocument ?? document;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target)) onOutsideDismiss();
    };
    ownerDocument.addEventListener("pointerdown", dismissOutside, true);
    return () => ownerDocument.removeEventListener("pointerdown", dismissOutside, true);
  }, [query, anchorRef, onOutsideDismiss]);
  const recoverOptionFocus = useCallback((option: HTMLButtonElement|null) => {
    if (!option) return;
    // React detaches the ref before removing the option, while its focus is still observable.
    return () => {
      if (option.ownerDocument.activeElement === option) inputRef.current?.focus();
    };
  }, [inputRef]);
  if (query === null) return null;
  const entries = listCanonicalSlashEntries(instance, projectSkills.catalog);
  const filtered = loading ? [] : filterCanonicalSlashEntries(entries, query);
  return <div ref={listRef} role="listbox" aria-label="Skills and commands" style={{zIndex:SHELL_Z_INDEX.popover}} className="absolute inset-x-0 bottom-full mb-2 min-w-0 max-w-full max-h-56 overflow-y-auto rounded-xl border border-border bg-popover p-2 shadow-sm" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); onDismiss(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]'));
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  }}>
    <p className="px-2 pb-1 text-xs text-muted-foreground">Skills &amp; commands</p>
    {filtered.map(entry => <button ref={recoverOptionFocus} type="button" role="option" aria-selected="false" key={`${entry.kind}:${entry.id}`} className="flex min-w-0 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>onSelect(entry)}>
      <span className="shrink-0">{entry.invocation}</span><span className="truncate text-xs text-muted-foreground">{entry.description}</span>
      {entry.kind === "project_skill" ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">Project</span> : null}
    </button>)}
    {!filtered.length ? <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{chatSlashStatusMessage({loading: loading || projectSkills.loading, instance, entryCount:entries.length, projectSkills:projectSkills.catalog})}</p> : null}
  </div>;
}
