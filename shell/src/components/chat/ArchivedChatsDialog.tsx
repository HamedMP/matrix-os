"use client";

import { useEffect, useRef, useState } from "react";
import type { CanonicalChatListResponse } from "@matrix-os/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

type ArchivedChat = CanonicalChatListResponse["items"][number];
const MAX_RETAINED_ARCHIVE_ROWS = 500;

export function ArchivedChatsDialog({ open, onClose, list, search, restore, remove }: {
  open: boolean;
  onClose(): void;
  list(cursor?: string): Promise<CanonicalChatListResponse>;
  search?(query: string, input: { lifecycle: "archived"; limit: number; cursor?: string }): Promise<CanonicalChatListResponse>;
  restore(chatId: string, revision: number): Promise<boolean>;
  remove(chatId: string): Promise<boolean>;
}) {
  const [rows, setRows] = useState<ArchivedChat[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return;
    const current = ++generation.current;
    setRows([]);
    setSelected([]);
    setConfirmDelete(false);
    setCursor(undefined);
    setLoading(true);
    setError(null);
    const load = () => (trimmedQuery && search
      ? search(trimmedQuery, { lifecycle: "archived", limit: 50 }) : list()).then(page => {
      if (generation.current !== current) return;
      setRows(page.items);
      setCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (generation.current !== current) return;
      console.warn("[chat] Archived chats unavailable:", cause instanceof Error ? cause.name : "UnknownError");
      setError("Archived chats could not be loaded. Try again.");
    }).finally(() => { if (generation.current === current) setLoading(false); });
    const timer = window.setTimeout(() => { void load(); }, trimmedQuery ? 250 : 0);
    return () => { generation.current++; window.clearTimeout(timer); };
  }, [open, list, search, trimmedQuery]);
  const more = () => {
    if (!cursor || loading || busy) return;
    const current = generation.current;
    setLoading(true);
    setError(null);
    void (trimmedQuery && search ? search(trimmedQuery, { lifecycle: "archived", limit: 50, cursor }) : list(cursor)).then(page => {
      if (generation.current !== current) return;
      const retained = [...rows, ...page.items.filter(item => !rows.some(row => row.chat.id === item.chat.id))].slice(-MAX_RETAINED_ARCHIVE_ROWS);
      setRows(retained);
      setSelected(current => current.filter(id => retained.some(row => row.chat.id === id)));
      setCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (generation.current !== current) return;
      console.warn("[chat] Archived chats page unavailable:", cause instanceof Error ? cause.name : "UnknownError");
      setError("More archived chats could not be loaded. Try again.");
    }).finally(() => { if (generation.current === current) setLoading(false); });
  };
  const apply = async (action: "restore" | "delete") => {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError(null);
    const completed: string[] = [];
    try {
      for (const row of rows.filter(item => selected.includes(item.chat.id))) {
        const success = action === "restore" ? await restore(row.chat.id, row.chat.revision) : await remove(row.chat.id);
        if (!success) throw new Error("ArchivedChatActionFailed");
        completed.push(row.chat.id);
      }
      setConfirmDelete(false);
    } catch (cause: unknown) {
      console.warn("[chat] Archived chat action failed:", cause instanceof Error ? cause.name : "UnknownError");
      setError(action === "restore" ? "Some chats could not be restored. Try again." : "Some chats could not be deleted. Try again.");
    } finally {
      setRows(current => current.filter(item => !completed.includes(item.chat.id)));
      setSelected(current => current.filter(id => !completed.includes(id)));
      setBusy(false);
    }
  };
  const close = () => { setQuery(""); onClose(); };
  return <>
    <Dialog open={open} onOpenChange={next => { if (!next && !busy) close(); }}>
      <DialogContent aria-label="Archived chats" className="sm:max-w-[600px]" style={{ zIndex: SHELL_Z_INDEX.appDialog }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog }}>
        <DialogHeader><DialogTitle>Archived chats</DialogTitle><DialogDescription>Chats stay here until you permanently delete them.</DialogDescription></DialogHeader>
        {search ? <Input type="search" aria-label="Search archived chats" placeholder="Search titles and messages…"
          maxLength={200} value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/> : null}
        <div className="max-h-[min(55vh,480px)] overflow-y-auto rounded-lg border border-border">
          {rows.map(row => <label key={row.chat.id} className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
            <input type="checkbox" aria-label={`Select ${row.chat.title}`} checked={selected.includes(row.chat.id)} disabled={busy}
              onChange={event => setSelected(current => event.target.checked ? [...current, row.chat.id] : current.filter(id => id !== row.chat.id))}/>
            <span className="min-w-0 flex-1 truncate text-sm">{row.chat.title}</span>
            <time className="text-xs text-muted-foreground" dateTime={row.chat.archivedAt ?? row.chat.updatedAt}>{new Date(row.chat.archivedAt ?? row.chat.updatedAt).toLocaleDateString()}</time>
          </label>)}
          {loading && rows.length === 0 ? <p role="status" className="p-3 text-sm">Loading archived chats…</p> : null}
          {!loading && rows.length === 0 && !error ? <p className="p-3 text-sm text-muted-foreground">{trimmedQuery ? "No archived chats match your search." : "No archived chats."}</p> : null}
          {cursor ? <button type="button" className="p-3 text-sm text-primary" disabled={loading || busy} onClick={more}>Show more</button> : null}
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>Close</Button>
          <Button type="button" variant="outline" disabled={busy || selected.length === 0} onClick={() => { void apply("restore"); }}>Restore selected</Button>
          <Button type="button" variant="destructive" disabled={busy || selected.length === 0} onClick={() => setConfirmDelete(true)}>Delete selected</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={confirmDelete} onOpenChange={next => { if (!next && !busy) setConfirmDelete(false); }}>
      <DialogContent role="alertdialog" aria-label="Delete archived chats?" className="sm:max-w-[400px]" showCloseButton={false}
        style={{ zIndex: SHELL_Z_INDEX.appDialog + 1 }} overlayStyle={{ zIndex: SHELL_Z_INDEX.appDialog + 1 }}>
        <DialogHeader><DialogTitle>Delete {selected.length} archived {selected.length === 1 ? "chat" : "chats"}?</DialogTitle>
          <DialogDescription>This permanently deletes the selected chats and their messages. This action cannot be undone.</DialogDescription></DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => { void apply("delete"); }}>Delete permanently</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
