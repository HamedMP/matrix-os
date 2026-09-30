import React, { useEffect, useRef, useState } from "react";
import { uploadLocalChatArchive, localChatImportErrorText, type ImportHarness, type LocalChatImportProgress, type LocalChatSourcePreview, type LocalChatUploadSource } from "@matrix-os/contracts/local-chat-import";
import { createBrowserChatSource } from "./local-source.js";
type Result = {
    chatId: string;
    jobId: string;
    messageCount: number;
};
type Transport = Parameters<typeof uploadLocalChatArchive>[2];
export interface NativeChatImportAdapter {
    select(harness: ImportHarness, signal: AbortSignal): Promise<{
        selectionId: string;
        preview: LocalChatSourcePreview;
    } | null>;
    apply(selectionId: string, title: string, signal: AbortSignal, progress: (value: LocalChatImportProgress) => void): Promise<Result | null>;
    pause(): void;
}
type Selection = {
    preview: LocalChatSourcePreview;
    source?: LocalChatUploadSource;
    selectionId?: string;
};
export function ChatImportPanel({ transport, native, onOpenChat }: {
    transport?: Transport;
    native?: NativeChatImportAdapter;
    onOpenChat?: (chatId: string, title: string) => void;
}) {
    const [harness, setHarness] = useState<ImportHarness>("codex");
    const [selection, setSelection] = useState<Selection | null>(null);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const generation = useRef(0);
    const operation = useRef<AbortController | null>(null);
    useEffect(() => () => { generation.current++; operation.current?.abort(); native?.pause(); }, [native, transport]);
    function begin() { operation.current?.abort(); const controller = new AbortController(); operation.current = controller; const current = ++generation.current; setBusy(true); setError(null); setProgress(null); return { controller, current }; }
    async function selectFile(file?: File) {
        const { controller, current } = begin();
        setSelection(null);
        setResult(null);
        try {
            let next: Selection | null = null;
            if (native) {
                const selected = await native.select(harness, controller.signal);
                if (selected)
                    next = selected;
            }
            else if (file) {
                const source = createBrowserChatSource(file);
                next = { preview: await source.preview(harness, controller.signal), source };
            }
            if (generation.current !== current || controller.signal.aborted)
                return;
            setSelection(next);
            if (next)
                setTitle(next.preview.title);
        }
        catch (cause: unknown) {
            if (generation.current === current)
                setError(localChatImportErrorText(cause));
        }
        finally {
            if (generation.current === current) {
                setBusy(false);
                operation.current = null;
            }
        }
    }
    async function importChat() {
        if (!selection || busy || result)
            return;
        const { controller, current } = begin();
        const preview = selection.preview;
        const onProgress = (value: LocalChatImportProgress) => { if (generation.current === current && !controller.signal.aborted)
            setProgress(value.phase === "verifying" ? "Verifying original bytes and building private Chat history…" : `${Math.round(value.uploadedBytes / value.totalBytes * 100)}% of the original transcript uploaded`); };
        try {
            const next = native && selection.selectionId ? await native.apply(selection.selectionId, title.trim() || preview.title, controller.signal, onProgress)
                : transport && selection.source ? await uploadLocalChatArchive({ harness: preview.harness, sourceId: preview.sourceId, ...(preview.sourceAgentId ? { sourceAgentId: preview.sourceAgentId } : {}), sourceHash: preview.sourceHash, rawSize: preview.rawBytes, title: title.trim() || preview.title }, selection.source, transport, { signal: controller.signal, onProgress }) : null;
            if (generation.current === current && !controller.signal.aborted) {
                if (next) {
                    setResult(next);
                    setProgress(null);
                }
                else
                    setError("Stopped waiting. Retry the same file to check its import status.");
            }
        }
        catch (cause: unknown) {
            if (generation.current === current)
                setError(localChatImportErrorText(cause));
        }
        finally {
            if (generation.current === current) {
                setBusy(false);
                operation.current = null;
            }
        }
    }
    function pause() { operation.current?.abort(); native?.pause(); setProgress(null); setError("Stopped waiting. Retry the same file to check its import status."); }
    const preview = selection?.preview;
    return <section className="mx-auto max-w-2xl space-y-4 text-sm">
  <div><h2 className="text-xl font-semibold">Import chats</h2><p className="mt-1 text-[var(--text-secondary,var(--muted-foreground))]">Bring a local Codex or Claude Code transcript into Matrix. Preview it before uploading readable history and a private original archive.</p></div>
  <label className="block space-y-1"><span>Chat tool</span><select value={harness} disabled={busy} onChange={event => { setHarness(event.target.value as ImportHarness); setSelection(null); setResult(null); setError(null); setProgress(null); }}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
  {native ? <button type="button" disabled={busy} onClick={() => void selectFile()} className="rounded border border-[var(--border-default,var(--border))] px-3 py-2">Choose transcript</button> : <label className="block space-y-1"><span>Choose a {harness === "codex" ? "Codex" : "Claude Code"} transcript</span><input type="file" accept=".jsonl,application/jsonl" disabled={busy} onChange={event => void selectFile(event.currentTarget.files?.[0])}/></label>}
  {preview ? <div className="space-y-3 rounded-lg border border-[var(--border-default,var(--border))] p-4">
   <p>{preview.counts.humanInputs} human inputs · {preview.counts.assistantResponses} assistant responses</p>
   <p>{preview.counts.toolCalls} tool {preview.counts.toolCalls === 1 ? "call" : "calls"} · {preview.counts.toolResults} tool results · {preview.counts.attachments} embedded attachments</p>
   <p className="break-all text-[var(--text-secondary,var(--muted-foreground))]">Session: {preview.sourceId}</p>
   {preview.recordedDirectory ? <p className="break-all text-[var(--text-secondary,var(--muted-foreground))]">Recorded directory: {preview.recordedDirectory}</p> : null}
   {preview.repositoryUrl ? <p className="break-all text-[var(--text-secondary,var(--muted-foreground))]">Recorded repository: {preview.repositoryUrl}</p> : null}
   {preview.counts.externalReferences ? <p>{preview.counts.externalReferences} external {preview.counts.externalReferences === 1 ? "reference" : "references"} cannot be recovered from this file. Referenced local files are not automatically uploaded.</p> : null}
   {preview.counts.sourceIssues ? <p>{preview.counts.sourceIssues} source {preview.counts.sourceIssues === 1 ? "issue" : "issues"} recorded. Original bytes are preserved; incomplete or damaged content may not be readable.</p> : null}
   {preview.firstVisibleText ? <div className="rounded border border-[var(--border-default,var(--border))] p-3"><p className="font-medium">First visible message</p><p className="mt-1 whitespace-pre-wrap break-words">{preview.firstVisibleText}</p></div> : null}
   <label className="block space-y-1"><span>Chat title</span><input type="text" maxLength={160} disabled={busy || Boolean(result)} value={title} onChange={event => setTitle(event.target.value)} className="w-full rounded border border-[var(--border-default,var(--border))] bg-transparent px-2 py-1"/></label>
   <p className="text-[var(--text-secondary,var(--muted-foreground))]">History includes saved messages, tools, and supported embedded attachments. Internal context and thinking stay in the private original archive. Transcripts may contain pasted secrets. This Chat stays private until you explicitly share it; sharing a Chat does not share its original archive.</p>
   <button type="button" disabled={busy || Boolean(result) || !title.trim()} onClick={() => void importChat()} className="rounded bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50">Import private Chat</button>
  </div> : null}
  {busy && !preview ? <p role="status">Reading transcript…</p> : null}{progress ? <p role="status">{progress}</p> : null}
  {busy ? <button type="button" onClick={pause}>Stop waiting</button> : null}
  {error ? <p role="alert">{error}</p> : null}
  {result ? <div role="status" className="space-y-2"><p>Imported {result.messageCount} history {result.messageCount === 1 ? "entry" : "entries"} into Matrix Chat.</p>{onOpenChat ? <button type="button" onClick={() => onOpenChat(result.chatId, title || preview?.title || "Imported Chat")}>Open Chat</button> : null}</div> : null}
 </section>;
}
