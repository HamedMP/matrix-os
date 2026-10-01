"use client";
import { useMemo, useState, type ReactNode } from "react";
import { OrganizationDriveUploadFolderSchema, type OrganizationDriveFile } from "@matrix-os/contracts";
import { driveBrowserEntries, driveFileSize } from "./browser-model.js";

const control = "min-h-9 rounded-md border px-3 py-1.5 text-xs hover:bg-[var(--bg-hover,var(--muted))] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50";
const border = {borderColor: "var(--border-default,var(--border))"};
const muted = {color: "var(--text-secondary,var(--muted-foreground))"};
function EntryIcon({folder}: {folder: boolean}) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="shrink-0" style={muted}>
    {folder ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/> : <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>}
  </svg>;
}
export type DriveChatContextSelection = {kind:"drive"}|{kind:"folder";path:string}|{kind:"file";file:OrganizationDriveFile};
export type OrganizationDriveBrowserProps = {
  name: string; files: readonly OrganizationDriveFile[]; usedBytes: number; reservedBytes: number; quotaBytes: number;
  busy: boolean; canUpload: boolean; folder: string; onFolderChange(folder: string): void;
  onDownload(file: OrganizationDriveFile): void; uploadControl?: ReactNode;
  onChatContext?(selection:DriveChatContextSelection):void;
  hasMore?: boolean; onLoadMore?(): void; pageLimitReached?: boolean;
};
/** Same browsing, copy and derivations for Web Canvas, Web Desktop, Web Mobile and Electron Desktop. */
export function OrganizationDriveBrowser(props: OrganizationDriveBrowserProps) {
  const [query, setQuery] = useState("");
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [uploadFolder, setUploadFolder] = useState(props.folder);
  const [folderError, setFolderError] = useState(false);
  const [sort, setSort] = useState<"name" | "modified">("name");
  const entries = useMemo(() => driveBrowserEntries(props.files, props.folder, query, sort), [props.files, props.folder, query, sort]);
  const folders = props.folder ? props.folder.split("/") : [];
  const usedPercent = Math.min(100, Math.max(0, (props.usedBytes + props.reservedBytes) / props.quotaBytes * 100));
  const navigate = (path: string) => {setQuery(""); props.onFolderChange(path);};
  function chooseFolder() {
    const value = uploadFolder.trim();
    const parsed = OrganizationDriveUploadFolderSchema.safeParse(value);
    if (!parsed.success) {setFolderError(true); return;}
    navigate(value); setChoosingFolder(false); setFolderError(false);
  }
  return <section className="flex min-w-0 flex-1 flex-col gap-4" aria-label={`${props.name} drive`}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-base font-semibold">{props.name}</h3><p className="mt-1 text-xs" style={muted}>Shared with your organization · {props.canUpload ? "Can upload" : "View access"}</p></div>
      {props.canUpload ? <div className="flex flex-wrap gap-2">
        <button type="button" disabled={props.busy} className={control} style={border} onClick={() => {setUploadFolder(props.folder); setChoosingFolder(true); setFolderError(false);}}>Choose upload folder</button>
        {props.uploadControl}
      </div> : null}
    </header>
    {choosingFolder && props.canUpload ? <form onSubmit={event => {event.preventDefault(); chooseFolder();}} className="space-y-2 rounded-md border p-3" style={border}>
      <label className="block text-xs">Upload folder path<input type="text" value={uploadFolder} maxLength={798} disabled={props.busy} placeholder="reports/2027" onChange={event => setUploadFolder(event.target.value)} className={`${control} mt-1 w-full bg-transparent`} style={border}/></label>
      <p className="text-xs" style={muted}>New folders appear after their first upload. File names must fit within the remaining path length. Leave blank for the drive root.</p>
      {folderError ? <p role="alert" className="text-xs">Enter a relative folder path of at most 798 bytes, without empty segments, backslashes or parent traversal.</p> : null}
      <div className="flex gap-2"><button type="submit" disabled={props.busy} className={control} style={border}>Use folder</button><button type="button" className={control} style={border} onClick={() => setChoosingFolder(false)}>Cancel</button></div>
    </form> : null}
    {props.onChatContext ? <div className="flex flex-wrap items-center gap-2"><button type="button" disabled={props.busy} className={control} style={border} aria-label={props.folder?"Ask about this folder":"Ask about this drive"} onClick={()=>props.onChatContext?.(props.folder?{kind:"folder",path:props.folder}:{kind:"drive"})}>Ask in Chat</button><span className="text-xs" style={muted}>Opens a new private Chat draft.</span></div>:null}
    <div className="space-y-2"><div className="flex flex-wrap justify-between gap-2 text-xs" style={muted}>
      <span>{driveFileSize(props.usedBytes)} of {driveFileSize(props.quotaBytes)} used</span>
      {props.reservedBytes > 0 ? <span>{driveFileSize(props.reservedBytes)} uploading</span> : null}
    </div><div role="meter" aria-label="Drive storage" aria-valuemin={0} aria-valuemax={props.quotaBytes} aria-valuenow={props.usedBytes + props.reservedBytes} aria-valuetext={`${driveFileSize(props.usedBytes)} used`} className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover,var(--muted))]">
      <div className="h-full rounded-full bg-[var(--primary)]" style={{width: `${usedPercent}%`}}/>
    </div></div>
    <nav aria-label="Drive folders" className="flex flex-wrap items-center gap-1 text-xs">
      <button type="button" disabled={props.busy} className={control} style={border} aria-label={`${props.name} drive root`} onClick={() => navigate("")}>{props.name}</button>
      {folders.map((name, index) => <button type="button" key={index} disabled={props.busy} className={control} style={border} aria-current={index === folders.length - 1 ? "page" : undefined} onClick={() => navigate(folders.slice(0, index + 1).join("/"))}>{name}</button>)}
    </nav>
    <div className="flex flex-wrap gap-2">
      <input type="search" aria-label="Search drive files" placeholder="Search files…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} className={`${control} min-w-0 basis-48 flex-1 bg-transparent`} style={border}/>
      <select aria-label="Sort drive files" value={sort} onChange={event => setSort(event.target.value as "name" | "modified")} className={`${control} bg-[var(--bg-surface,var(--background))]`} style={border}><option value="name">Name</option><option value="modified">Recently modified</option></select>
    </div>
    {props.canUpload ? <p className="text-xs" style={muted}>{props.folder ? `Uploads go to ${props.folder}.` : "Uploads go to the drive root."}</p> : null}
    {props.canUpload && new TextEncoder().encode(props.folder).byteLength > 544 ? <p className="text-xs" style={muted}>This folder leaves {Math.max(0, 799 - new TextEncoder().encode(props.folder).byteLength)} UTF-8 bytes for each file name.</p> : null}
    {props.hasMore ? <p className="text-xs" style={muted}>{props.pageLimitReached ? "Search covers loaded files. This view has reached its browsing limit." : "Search covers loaded files. Load more to include additional files."}</p> : null}
    <ul className="min-w-0 divide-y rounded-lg border px-3" style={border} aria-label="Drive files">
      {entries.map(entry => <li key={`${entry.kind}:${entry.path}`} className="flex min-w-0 flex-wrap items-center gap-3 py-3" style={border}>
        <EntryIcon folder={entry.kind === "folder"}/>
        <div className="min-w-0 flex-1 basis-32">
          {entry.kind === "folder" ? <button type="button" aria-label={`Open folder ${entry.name}`} disabled={props.busy} onClick={() => navigate(entry.path)} className="min-h-9 w-full truncate text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{entry.name}</button> : <p className="truncate text-sm" title={entry.path}>{entry.name}</p>}
          <p className="truncate text-xs" style={muted}>{entry.kind === "folder" ? `${entry.fileCount} loaded ${entry.fileCount === 1 ? "file" : "files"}` : query.trim() ? entry.path : `${driveFileSize(entry.file.size)} · ${entry.file.updatedAt.slice(0,10)}`}</p>
        </div>
        {props.onChatContext ? <button type="button" disabled={props.busy} className={control} style={border} aria-label={`Add ${entry.name}${entry.kind==="folder"?" folder":""} to Chat`} onClick={()=>props.onChatContext?.(entry.kind==="file"?{kind:"file",file:entry.file}:{kind:"folder",path:entry.path})}>Add to Chat</button>:null}
        {entry.kind === "file" ? <button type="button" disabled={props.busy} className={control} style={border} aria-label={`Download ${entry.name}`} onClick={() => props.onDownload(entry.file)}>Download</button> : null}
      </li>)}
    </ul>
    {entries.length === 0 ? <p className="py-6 text-center text-sm" style={muted}>{query.trim() ? "No matching loaded files. Try another search." : "No files in this folder yet."}</p> : null}
    {props.hasMore && props.onLoadMore ? <div><button type="button" className={control} style={border} disabled={props.busy || props.pageLimitReached} onClick={props.onLoadMore}>Load more files</button>{props.pageLimitReached ? <p className="mt-2 text-xs" style={muted}>The browsing limit is reached for this view.</p> : null}</div> : null}
  </section>;
}
