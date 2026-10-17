import React, { useId, useState } from "react";
import { CheckCircle2, FolderOpen, LockKeyhole, MessageSquare, Upload } from "lucide-react";
import { LocalChatLibrary } from "./LocalChatLibrary.js";
import { ChatImportSourceIcon } from "../chat/ChatImportSource.js";
import { ImportChatRow } from "./ImportChatRow.js";
import { importBytes, MAX_IMPORT_SELECTIONS, validImportTitle, type ImportTransport, type NativeChatImportAdapter } from "./import-state.js";
import { useChatImport } from "./use-chat-import.js";
export type { NativeChatImportAdapter } from "./import-state.js";
export function ChatImportPanel({ transport, native, onOpenChat }: {
    transport?: ImportTransport; native?: NativeChatImportAdapter; onOpenChat?: (chatId: string, title: string) => void;
}) {
    const state = useChatImport({ native, transport });
    const inputId = useId();
    const [showAll, setShowAll] = useState(true);
    const discovers = Boolean(native?.discover && native.prepare);
    const { harness, items, busy, error } = state;
    const ready = items.filter(item => item.status === "ready");
    const failed = items.filter(item => item.status === "failed");
    const imported = items.filter(item => item.status === "imported").length;
    const canImport = (list: typeof items) => !busy && !state.library.loading && !state.library.error && list.length > 0 && list.every(item => validImportTitle(item.title));
    const full = items.length >= MAX_IMPORT_SELECTIONS;
    return <section className="matrix-chat-import" aria-label="Import chats">
        <header className="matrix-import-header"><h2>Import chats</h2><p>Bring your Claude Code and Codex conversations together in Matrix. Each conversation becomes its own private chat.</p></header>
        <div className="matrix-import-sources" role="group" aria-label="Chat tool">
            {(["codex", "claude"] as const).map(value => <button key={value} type="button" aria-label={value === "codex" ? "Codex" : "Claude Code"} aria-pressed={harness === value && (!discovers || !showAll)} disabled={Boolean(busy)} onClick={() => { state.setHarness(value); setShowAll(false); }} className="matrix-import-source">
                <span className="matrix-import-source-mark" aria-hidden="true"><ChatImportSourceIcon harness={value} size={24} imported={false}/></span>
                <span><strong>{value === "codex" ? "Codex" : "Claude Code"}</strong><small>{value === "codex" ? "Local sessions" : "Project conversations"}</small></span>
                <span className="matrix-import-source-check" aria-hidden="true">{harness === value && (!discovers || !showAll) ? <CheckCircle2 size={17}/> : null}</span>
            </button>)}
        </div>
        {discovers && native ? <><button type="button" className="matrix-import-text-button" aria-pressed={showAll} disabled={Boolean(busy)} onClick={()=>setShowAll(true)}>Show both apps</button><LocalChatLibrary key={state.batchRevision} library={state.library} harness={showAll ? "all" : harness} busy={Boolean(busy)} results={state.localResults} imported={state.localImportedCount} active={state.localActive} onPrepare={keys=>state.selectFiles(undefined,keys)} onImport={state.importLocal} onOpen={onOpenChat}/></> : <>
        <div className="matrix-import-picker">
            <FolderOpen size={25} aria-hidden="true"/><div><strong>Choose conversations from this computer</strong><p>Select up to {MAX_IMPORT_SELECTIONS} transcript files. Review them before anything is uploaded.</p></div>
            {native ? <button type="button" className="matrix-import-button" disabled={Boolean(busy) || full} onClick={() => void state.selectFiles()}>{native.selectMany ? "Choose transcripts" : "Choose transcript"}</button> : <label className="matrix-import-button matrix-import-file-picker" htmlFor={inputId} aria-disabled={Boolean(busy) || full}>
                Choose transcripts<input id={inputId} type="file" multiple accept=".jsonl,application/jsonl" aria-label={`Choose a ${harness === "codex" ? "Codex" : "Claude Code"} transcript`} disabled={Boolean(busy) || full} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) void state.selectFiles(files); }}/>
            </label>}
        </div></>}

        {discovers ? <p className="matrix-import-note">Imported history is private. Transcripts may contain pasted secrets. Sharing a chat does not share its original archive.</p> : null}
        {busy && discovers && !items.length ? <button type="button" className="matrix-import-button" onClick={state.pause}>Stop waiting</button> : null}
        {busy === "reading" ? <div className="matrix-import-library-actions"><p className="matrix-import-reading" role="status">Reading transcripts on this computer…</p>{!discovers && !items.length ? <button type="button" className="matrix-import-button" onClick={state.pause}>Stop waiting</button> : null}</div> : null}
        {error ? <p className="matrix-import-error" role="alert">{error}</p> : null}
        {items.length ? <div className="matrix-import-review">
            <div className="matrix-import-review-head"><div><h3>{imported === items.length ? "Your chats are in Matrix" : "Review conversations"}</h3><p>{items.length} {items.length === 1 ? "conversation" : "conversations"} · {importBytes(items.reduce((sum, item) => sum + item.preview.rawBytes, 0))} of original history</p></div>
                {imported === items.length ? <button type="button" className="matrix-import-text-button" onClick={state.reset}>Start another batch</button> : <span className="matrix-import-private"><LockKeyhole size={14} aria-hidden="true"/>Private</span>}
            </div>
            <ul className="matrix-import-list">{items.map(item => <ImportChatRow key={item.key} item={item} single={items.length === 1} busy={Boolean(busy)} onTitle={title => state.changeTitle(item.key, title)} onRemove={() => state.remove(item.key)} onOpen={onOpenChat}/>)}</ul>
            {imported > 0 && items.length > 1 ? <p className="matrix-import-completion" role="status"><CheckCircle2 size={17} aria-hidden="true"/>{imported === 1 ? "1 chat is ready in Matrix." : `${imported} chats are ready in Matrix.`}</p> : null}
            <footer className="matrix-import-footer">
                <div className="matrix-import-privacy"><LockKeyhole size={16} aria-hidden="true"/><p>Saved messages, tools, and supported embedded attachments become readable history. Internal context and thinking stay in the private original archive. Transcripts may contain pasted secrets. Sharing a chat does not share its original archive.</p></div>
                <div className="matrix-import-actions"><p>{discovers ? busy === "importing" ? "Importing your selection one conversation at a time." : "Choose conversations in the list above, then import your selection." : busy === "importing" ? `Importing chats one at a time. ${imported} of ${items.length} ready.` : "Original files stay unchanged. Retrying the same transcript won’t create a duplicate import."}</p>
                    <div>{!discovers && failed.length ? <button type="button" className="matrix-import-button" disabled={!canImport(failed)} onClick={() => void state.importChats("failed")}>Retry {failed.length} {failed.length === 1 ? "chat" : "chats"}</button> : null}
                        {!discovers && ready.length ? <button type="button" className="matrix-import-button matrix-import-primary" disabled={!canImport(ready)} onClick={() => void state.importChats()}><Upload size={15} aria-hidden="true"/>{ready.length === 1 ? "Import private Chat" : `Import ${ready.length} private chats`}</button> : null}
                        {busy ? <button type="button" className="matrix-import-button" onClick={state.pause}>Stop waiting</button> : null}
                    </div>
                </div>
            </footer>
        </div> : discovers ? null : <div className="matrix-import-empty"><MessageSquare size={22} aria-hidden="true"/><div><strong>Your history, in one place</strong><p>Keep working from your imported chats, with their original history preserved. Add conversations from either tool to the same batch.</p></div></div>}
    </section>;
}
