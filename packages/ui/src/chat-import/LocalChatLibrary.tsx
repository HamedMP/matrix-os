import React, { useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { type ImportHarness } from "@matrix-os/contracts/local-chat-import";
import { ChatImportSourceIcon } from "../chat/ChatImportSource.js";
import { importBytes, type LocalChatCandidate, type LocalChatLibraryState, type LocalImportOutcome, type LocalImportUpdate } from "./import-state.js";
const PAGE_SIZE = 100;
export function LocalChatLibrary({library,harness,busy,results,imported,active,onPrepare,onImport,onOpen}: {
    library:LocalChatLibraryState; harness:ImportHarness | "all"; busy:boolean;
    results:Record<string,LocalImportOutcome>;imported:number;active:LocalImportUpdate|null;
    onPrepare(keys:string[]):Promise<void>;onImport(keys:string[]):Promise<void>;onOpen?:(chatId:string,title:string)=>void;
}) {
    const {sources,loading,error,limited,refresh} = library;
    const [excluded,setExcluded]=useState<string[]>([]);
    const [query,setQuery]=useState("");
    const [page,setPage]=useState(0);
    const search=query.trim().toLocaleLowerCase();
    const visible=useMemo(()=>sources.filter(source=>(harness==="all" || source.harness===harness) && `${source.title}\n${source.recordedDirectory??""}`.toLocaleLowerCase().includes(search)),[sources,harness,search]);
    const excludedKeys=useMemo(()=>new Set(excluded),[excluded]); // render-scoped, bounded by discovered catalog, discarded on refresh/unmount.
    const selected=useMemo(()=>sources.filter(source=>!excludedKeys.has(source.sourceKey) && results[source.sourceKey]?.status!=="imported"),[sources,excludedKeys,results]);
    const selectedVisible=useMemo(()=>visible.filter(source=>!excludedKeys.has(source.sourceKey) && results[source.sourceKey]?.status!=="imported").length,[visible,excludedKeys,results]);
    const disabled=busy||loading||Boolean(error);
    const lastPage=Math.max(0,Math.ceil(visible.length/PAGE_SIZE)-1);
    const currentPage=Math.min(page,lastPage);
    const shown=visible.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);
    function toggle(key:string){setExcluded(previous=>previous.includes(key)?previous.filter(value=>value!==key):[...previous,key]);}
    return <div className="matrix-import-library">
        <div className="matrix-import-library-head"><div><h3>Conversations on this computer</h3><p>Found in <span data-selectable>~/.claude</span> and <span data-selectable>~/.codex</span>. All selected by default. Uncheck any you want to leave out.</p></div>
            <button type="button" className="matrix-import-icon-button" aria-label="Refresh local conversations" title="Refresh the list and reset previews" disabled={busy||loading} onClick={()=>{setExcluded([]);setPage(0);refresh();}}><RefreshCw size={17} aria-hidden="true"/></button>
        </div>
        <label className="matrix-import-search"><Search size={15} aria-hidden="true"/><input type="search" aria-label="Search local conversations" placeholder="Search conversations or projects" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/></label>
        <LocalSourceList loading={loading} error={error} total={sources.length} matches={visible.length}>{shown.map(source=><LocalSourceRow key={source.sourceKey} source={source} selected={!excludedKeys.has(source.sourceKey) && results[source.sourceKey]?.status!=="imported"} disabled={disabled} outcome={results[source.sourceKey]} active={active?.sourceKey===source.sourceKey?active:null} toggle={toggle} preview={()=>void onPrepare([source.sourceKey])} onOpen={onOpen}/>)}</LocalSourceList>
        <LibraryPagination count={visible.length} page={currentPage} lastPage={lastPage} onPage={setPage}/>
        {limited?<p className="matrix-import-note">The scan reached its safety limit. Some conversations may be outside this list.</p>:null}
        <SelectionActions total={sources.length} selected={selected.length} hidden={selected.length-selectedVisible} disabled={disabled} onAll={()=>setExcluded([])} onNone={()=>setExcluded(sources.map(source=>source.sourceKey))} onImport={()=>void onImport(selected.map(source=>source.sourceKey))}/>
        <p className="matrix-import-note">Nothing uploads until you choose Import. Original files stay unchanged. Retrying the same transcript won’t create a duplicate import.</p>
        <QueueProgress active={active} imported={imported}/>
    </div>;
}
function LocalSourceRow({source,selected,disabled,outcome,active,toggle,preview,onOpen}: {source:LocalChatCandidate;selected:boolean;disabled:boolean;outcome?:LocalImportOutcome;active:LocalImportUpdate|null;toggle(key:string):void;preview():void;onOpen?:(chatId:string,title:string)=>void}) {
    const project=source.recordedDirectory?.split(/[\\/]/).filter(Boolean).at(-1);
    return <li><div className="matrix-import-candidate-wrap"><label className="matrix-import-candidate">
        <input type="checkbox" aria-label={`Select ${source.title}`} checked={selected} disabled={disabled || outcome?.status==="imported"} onChange={()=>toggle(source.sourceKey)}/>
        <ChatImportSourceIcon harness={source.harness} size={17} imported={false}/>
        <span className="matrix-import-candidate-copy"><strong>{source.title}</strong><small>{source.harness==="claude"?"Claude Code":"Codex"}{project?` · ${project}`:""}{outcome?.status==="imported"?" · Imported":active?" · Importing…":""}</small></span>
        <span className="matrix-import-candidate-date"><time dateTime={source.updatedAt}>{new Date(source.updatedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</time><small>{importBytes(source.rawBytes)}</small></span>
    </label>{outcome?.result && onOpen?<button type="button" className="matrix-import-text-button" aria-label={`Open ${source.title}`} onClick={()=>onOpen(outcome.result!.chatId,source.title)}>Open</button>:<button type="button" className="matrix-import-text-button" aria-label={`Preview ${source.title}`} disabled={disabled || outcome?.status==="imported"} onClick={preview}>Preview</button>}</div>{outcome?.error?<p className="matrix-import-candidate-error" role="alert">{outcome.error}</p>:null}</li>;
}

function LocalSourceList({loading,error,total,matches,children}: {loading:boolean;error:string|null;total:number;matches:number;children:React.ReactNode}) {
    if(loading)return <p className="matrix-import-library-message" role="status">Finding local conversations…</p>;
    if(error)return <p className="matrix-import-error" role="alert">{error}</p>;
    if(!total)return <div className="matrix-import-library-message"><strong>No local conversations found.</strong><p>Use Claude Code or Codex on this computer, then refresh. Your other computer’s history won’t appear here.</p></div>;
    if(!matches)return <p className="matrix-import-library-message">No conversations match this search.</p>;
    return <ul className="matrix-import-candidates" aria-label="Local conversations">{children}</ul>;
}

function LibraryPagination({count,page,lastPage,onPage}:{count:number;page:number;lastPage:number;onPage(page:number):void}) {
    if(count<=PAGE_SIZE)return null;
    return <div className="matrix-import-library-actions"><span>{page*PAGE_SIZE+1}–{Math.min((page+1)*PAGE_SIZE,count)} of {count} matching conversations</span><div><button type="button" className="matrix-import-text-button" disabled={page===0} onClick={()=>onPage(page-1)}>Previous page</button><button type="button" className="matrix-import-text-button" disabled={page===lastPage} onClick={()=>onPage(page+1)}>Next page</button></div></div>;
}
function SelectionActions({total,selected,hidden,disabled,onAll,onNone,onImport}:{total:number;selected:number;hidden:number;disabled:boolean;onAll():void;onNone():void;onImport():void}) {
    return <div className="matrix-import-library-actions"><span>{total} found · {selected} selected{hidden>0?` · ${hidden} hidden by filters`:""}</span><div>
        <button type="button" className="matrix-import-text-button" disabled={disabled || !total} onClick={onAll}>Select all</button><button type="button" className="matrix-import-text-button" disabled={disabled || !selected} onClick={onNone}>Deselect all</button>
        <button type="button" className="matrix-import-button matrix-import-primary" disabled={disabled || !selected} onClick={onImport}>Import {selected} selected {selected===1?"chat":"chats"}</button>
    </div></div>;
}
function QueueProgress({active,imported}:{active:LocalImportUpdate|null;imported:number}) {
    return <>{active?<div className="matrix-import-transfer" role="status"><strong>{active.status==="reading"?"Reading":"Importing"} {active.title}</strong><p>{active.processed} of {active.total} processed · One conversation at a time</p>{active.progress?<progress max={active.progress.totalBytes || 1} value={active.progress.uploadedBytes}/>:null}</div>:null}
        {imported>0?<p className="matrix-import-completion" role="status">{imported} {imported===1?"chat":"chats"} ready in Matrix.</p>:null}</>;
}
