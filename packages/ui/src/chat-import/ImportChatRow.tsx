import React from "react";
import { CheckCircle2, ChevronRight, X } from "lucide-react";
import { ChatImportSourceIcon } from "../chat/ChatImportSource.js";
import { importBytes, type ImportItem } from "./import-state.js";
import { importProgressPresentation } from "./import-progress.js";
export function ImportChatRow({ item, busy, single, onTitle, onRemove, onOpen }: {
    item: ImportItem; busy: boolean; single: boolean;
    onTitle(title: string): void; onRemove(): void; onOpen?: (chatId: string, title: string) => void;
}) {
    const { preview, result, status } = item;
    const statusText = importStatus(item);
    return <li className="matrix-import-row" data-status={status}>
        <div className="matrix-import-row-head">
            <span className="matrix-import-file" aria-hidden="true">{result ? <CheckCircle2 size={20}/> : <ChatImportSourceIcon harness={preview.harness} size={20} imported={false}/>}</span>
            <div className="matrix-import-row-heading">
                <label className="matrix-import-title"><span className="matrix-import-sr-only">{single ? "Chat title" : `Chat title for ${preview.title}`}</span>
                    <input type="text" maxLength={160} disabled={busy || status === "imported"} value={item.title} onChange={event => onTitle(event.target.value)}/>
                </label>
                <div className="matrix-import-meta"><span>{preview.harness === "codex" ? "Codex" : "Claude Code"}</span><span>{preview.counts.humanInputs} human inputs · {preview.counts.assistantResponses} assistant responses</span><span>{importBytes(preview.rawBytes)}</span></div>
            </div>
            <span className="matrix-import-state">{statusText}</span>
            {!result ? <button type="button" className="matrix-import-icon-button" aria-label={`Remove ${item.catalogKey ? "preview for " : ""}${item.title}`} disabled={busy} onClick={onRemove}><X size={16}/></button> : null}
        </div>
        {preview.firstVisibleText ? <p className="matrix-import-snippet" data-selectable>{preview.firstVisibleText}</p> : null}
        {status === "importing" ? <ImportTransfer item={item}/> : null}
        {item.error ? <p className="matrix-import-error" role="alert">{item.error}</p> : null}
        <ImportDetails item={item}/>
        <ImportResult item={item} single={single} onOpen={onOpen}/>
    </li>;
}

function importStatus(item: ImportItem) {
    switch (item.status) {
        case "imported": return "In Matrix";
        case "failed": return "Needs retry";
        case "reading": return "Reading transcript…";
        case "importing": return importProgressPresentation(item.progress,item.preview.rawBytes).status;
        default: return "Ready to import";
    }
}
function ImportTransfer({item}: {item: ImportItem}) {
    const {preview,progress} = item;
    const presentation = importProgressPresentation(progress,preview.rawBytes);
    return <div className="matrix-import-transfer" role="status" aria-busy="true">
        <p>{presentation.detail}</p>
        <progress aria-label={`${presentation.progressLabel} for ${item.title}`} max={100} value={presentation.percent}/>
    </div>;
}
function ImportDetails({item}: {item: ImportItem}) {
    const {preview,result} = item;
    return <>
        {!result ? <details className="matrix-import-details">
            <summary>History and source details</summary>
            <div data-selectable>
                <p>{preview.counts.toolCalls} tool {preview.counts.toolCalls === 1 ? "call" : "calls"} · {preview.counts.toolResults} tool results · {preview.counts.attachments} embedded attachments</p>
                <p>Session: {preview.sourceId}</p>
                {preview.recordedDirectory ? <p>Recorded directory: {preview.recordedDirectory}</p> : null}
                {preview.repositoryUrl ? <p>Recorded repository: {preview.repositoryUrl}</p> : null}
            </div>
        </details> : null}
        {preview.counts.externalReferences ? <p className="matrix-import-note">{preview.counts.externalReferences} external {preview.counts.externalReferences === 1 ? "reference" : "references"} cannot be recovered from this file. Referenced local files are not automatically uploaded.</p> : null}
        {preview.counts.sourceIssues ? <p className="matrix-import-note">{preview.counts.sourceIssues} source {preview.counts.sourceIssues === 1 ? "issue" : "issues"} recorded. Original bytes are preserved; incomplete or damaged content may not be readable.</p> : null}
    </>;
}

function ImportResult({item,single,onOpen}: {item:ImportItem;single:boolean;onOpen?:(chatId:string,title:string)=>void}) {
    const {result}=item;
    if(!result)return null;
    return <div className="matrix-import-result" role="status"><p>Imported {result.messageCount} history {result.messageCount===1?"entry":"entries"} into Matrix Chat.</p>
        {onOpen?<button type="button" className="matrix-import-text-button" aria-label={single?"Open Chat":`Open ${item.title}`} onClick={()=>onOpen(result.chatId,item.title)}>{single?"Open Chat":"Open chat"}<ChevronRight size={15} aria-hidden="true"/></button>:null}
    </div>;
}
