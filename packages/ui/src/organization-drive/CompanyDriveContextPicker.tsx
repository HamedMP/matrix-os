"use client";
import { useEffect, useMemo, useState } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import type { CollaborationDirectApi } from "../collaboration/direct-api.js";
import { canAddChatMention } from "../chat-agents/mentions.js";
import { driveBrowserEntries } from "./browser-model.js";
import { companyDriveChatReference } from "./context-reference.js";
import { loadOrganizationDriveOptions, type OrganizationDriveOption } from "./discovery.js";
const control = "min-h-9 rounded-md border px-3 py-1.5 text-xs hover:bg-[var(--bg-hover,var(--muted))] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--accent)]";
export function CompanyDriveContextPicker({ api, resources, onSelect, enabled, mentionQuery = null, disabled = false }: {
    api: CollaborationDirectApi | null;
    resources: CanonicalChatResourceReference[];
    onSelect(reference: CanonicalChatResourceReference): void;
    enabled: boolean;
    mentionQuery?: string | null;
    disabled?: boolean;
}) {
    const [explicitOpen, setExplicitOpen] = useState(false), [dismissed, setDismissed] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
    const [listing, setListing] = useState<{
        api: CollaborationDirectApi;
        options: OrganizationDriveOption[];
        error: boolean;
    } | null>(null);
    const [selection, setSelection] = useState<{
        api: CollaborationDirectApi;
        scopeId: string;
        folder: string;
        query: string;
    } | null>(null);
    const open = enabled && !disabled && (explicitOpen || (mentionQuery !== null && mentionQuery !== dismissed));
    useEffect(() => {
        if (!open || !api)
            return;
        let current = true;
        void loadOrganizationDriveOptions(api, {}).then(options => { if (current)
            setListing({ api, options, error: false }); }).catch((error: unknown) => {
            console.warn("[chat/drive-context] Listing unavailable", error instanceof Error ? error.name : "UnknownError");
            if (current)
                setListing({ api, options: [], error: true });
        });
        return () => { current = false; };
    }, [api, open, attempt]);
    const current = listing?.api === api ? listing : null;
    const drive = selection?.api === api ? current?.options.find(option => option.scopeId === selection.scopeId) : undefined;
    const folder = drive ? selection!.folder : "", query = drive ? selection!.query : "";
    const entries = useMemo(() => driveBrowserEntries(drive?.snapshot?.files ?? [], folder, query, "name"), [drive, folder, query]);
    const choose = (reference: CanonicalChatResourceReference) => { if (!canAddChatMention(resources, reference))
        return; onSelect(reference); setExplicitOpen(false); setDismissed(mentionQuery); setSelection(null); };
    const setLocation = (folder: string, query = "") => { if (drive && api)
        setSelection({ api, scopeId: drive.scopeId, folder, query }); };
    return <div className="min-w-0 space-y-2">
  <button type="button" className={control} aria-label="Add company drive context" aria-expanded={open} disabled={!enabled || disabled || !api} onClick={() => { setExplicitOpen(!open); setDismissed(open ? mentionQuery : null); }}>Add context</button>
  {!enabled ? <p className="text-xs" style={{ color: "var(--text-secondary,var(--muted-foreground))" }}>Choose Claude Code to use company drive context.</p> : null}
  {open && api ? <section aria-label="Company drive context" className="max-h-80 space-y-2 overflow-y-auto rounded-lg border p-3" style={{ borderColor: "var(--border-default,var(--border))", background: "var(--bg-surface,var(--background))" }}>
   <header className="flex items-center justify-between gap-2"><strong className="text-xs">Company drives</strong><button type="button" className={control} onClick={() => { setExplicitOpen(false); setDismissed(mentionQuery); }}>Close context picker</button></header>
   <p className="text-xs">Chat searches and reads current files as needed. Chats remain private.</p>
   {!current ? <p role="status" className="text-xs">Loading company drives…</p> : current.error ? <div><p role="alert" className="text-xs">Company drives could not be loaded. Try again.</p><button type="button" className={control} onClick={() => setAttempt(attempt + 1)}>Retry</button></div> : drive ? <>
    <nav className="flex flex-wrap gap-2" aria-label="Context folders"><button type="button" className={control} onClick={() => setSelection(null)}>All drives</button><button type="button" className={control} onClick={() => setLocation("")}>{drive.name}</button>{folder ? <button type="button" className={control} onClick={() => setLocation(folder.split("/").slice(0, -1).join("/"))}>Up one folder</button> : null}</nav>
    <p className="break-all text-xs">{folder || "Drive root"}</p>
    <button type="button" className={control} disabled={!canAddChatMention(resources, companyDriveChatReference(drive, folder ? { kind: "folder", path: folder } : undefined))} onClick={() => choose(companyDriveChatReference(drive, folder ? { kind: "folder", path: folder } : undefined))}>{folder ? "Add this folder to Chat" : `Add ${drive.name} drive to Chat`}</button>
    <input type="search" aria-label="Search context files" maxLength={200} placeholder="Search loaded files…" value={query} onChange={event => setLocation(folder, event.target.value)} className={`${control} w-full bg-transparent`}/>
    {drive.snapshot?.nextCursor ? <p className="text-xs">Search covers loaded files. Once added, Chat can search the current drive.</p> : null}
    <ul className="space-y-1">{entries.map(entry => <li key={entry.path} className="flex min-w-0 items-center gap-2">{entry.kind === "folder" ? <button type="button" className={`${control} min-w-0 flex-1 truncate text-left`} aria-label={`Open folder ${entry.name}`} onClick={() => setLocation(entry.path)}>{entry.name}/</button> : <><span className="min-w-0 flex-1 truncate text-xs" title={entry.path}>{entry.name} · v{entry.file.version}</span><button type="button" className={control} aria-label={`Add ${entry.name} to Chat`} disabled={!canAddChatMention(resources, companyDriveChatReference(drive, { kind: "file", fileId: entry.file.id, version: entry.file.version, path: entry.path }))} onClick={() => choose(companyDriveChatReference(drive, { kind: "file", fileId: entry.file.id, version: entry.file.version, path: entry.path }))}>Add file</button></>}</li>)}</ul>
    {entries.length === 0 ? <p className="text-xs">No matching loaded files.</p> : null}
   </> : <>
    {current.options.filter(option => option.name.toLocaleLowerCase().includes((mentionQuery ?? "").toLocaleLowerCase())).map(option => <div key={option.scopeId} className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs">{option.name}</span><button type="button" className={control} disabled={option.state !== "ready" || !canAddChatMention(resources, companyDriveChatReference(option))} aria-label={`Add ${option.name} drive to Chat`} onClick={() => choose(companyDriveChatReference(option))}>Add drive</button><button type="button" className={control} disabled={option.state !== "ready"} aria-label={`Browse ${option.name}`} onClick={() => setSelection({ api, scopeId: option.scopeId, folder: "", query: "" })}>Browse</button></div>)}
    {current.options.length === 0 ? <p className="text-xs">No accessible company drives.</p> : null}
   </>}
   {resources.filter(resource => resource.kind === "organization_drive").length >= 3 ? <p className="text-xs">Remove a drive context to add another. Each message supports three.</p> : null}
  </section> : null}
 </div>;
}
