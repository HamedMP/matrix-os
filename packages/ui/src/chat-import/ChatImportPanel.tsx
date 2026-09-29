import React, { useRef, useState } from "react";
import { submitCodexChatImport, type CodexChatImportRequest } from "@matrix-os/contracts/codex-chat-import-client";
import { previewCodexBrowserFile, type BrowserCodexImportPreview } from "./preview.js";

const SAFE_ERRORS = new Set([
  "Select a Codex JSONL file smaller than 20 GiB.",
  "Codex transcript has no supported messages or exceeds the import limit.",
  "Projected conversation exceeds the import limit.",
  "Codex transcript has no session identity",
  "Codex transcript contains multiple session identities",
  "Codex JSONL record exceeds the visible message limit",
  "Matrix returned an invalid Chat import response.",
  "Matrix returned an invalid Chat import result.",
  "Matrix returned an invalid Chat import offset.",
  "Matrix returned an incomplete Chat import.",
  "The imported Chat could not be verified.",
]);

function safeError(error: unknown): string {
  return error instanceof Error && (SAFE_ERRORS.has(error.message)
    || /^Invalid Codex JSONL at line [1-9][0-9]{0,9}$/.test(error.message)
    || /^Codex message has no valid timestamp at line [1-9][0-9]{0,9}$/.test(error.message))
    ? error.message
    : "Chat import failed. Your source file was not changed. Try again.";
}

export function ChatImportPanel({ request, onOpenChat }: {
  request: CodexChatImportRequest;
  onOpenChat?: (chatId: string, title: string) => void;
}) {
  const [preview, setPreview] = useState<BrowserCodexImportPreview | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ chatId: string; messageCount: number } | null>(null);
  const generation = useRef(0);

  async function selectFile(file: File | undefined) {
    const current = ++generation.current;
    setPreview(null);
    setResult(null);
    setProgress(null);
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const next = await previewCodexBrowserFile(file);
      if (generation.current !== current) return;
      setPreview(next);
      setTitle(next.title);
    } catch (cause) {
      if (generation.current === current) setError(safeError(cause));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  async function importChat() {
    if (!preview || busy || result) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const imported = await submitCodexChatImport({
        sourceId: preview.sourceId,
        sourceHash: preview.sourceHash,
        title: title.trim() || preview.title,
        messages: preview.messages,
      }, request, (sent, total) => setProgress(`${sent} of ${total} messages uploaded`));
      setResult(imported);
    } catch (cause) {
      setError(safeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="mx-auto max-w-2xl space-y-4 text-sm">
    <div>
      <h2 className="text-xl font-semibold">Import chats</h2>
      <p className="mt-1 text-[var(--text-secondary)]">Choose a local Codex session transcript. Matrix previews its conversation before you import it as a private Chat.</p>
    </div>
    <label className="block space-y-1">
      <span>Choose a Codex transcript</span>
      <input type="file" accept=".jsonl,application/jsonl" disabled={busy}
        onChange={(event) => void selectFile(event.currentTarget.files?.[0])} />
    </label>
    {preview ? <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
      <p>{preview.messages.length} {preview.messages.length === 1 ? "message" : "messages"} ready to import</p>
      <p className="break-all text-[var(--text-secondary)]">Session: {preview.sourceId}</p>
      <p className="break-all text-[var(--text-secondary)]">Recorded directory: {preview.cwd}</p>
      {preview.repositoryUrl ? <p className="break-all text-[var(--text-secondary)]">Recorded repository: {preview.repositoryUrl}</p> : null}
      <div className="rounded border border-[var(--border)] p-3">
        <p className="font-medium">First visible message</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{preview.messages[0]?.text.slice(0, 500)}</p>
      </div>
      <label className="block space-y-1">
        <span>Chat title</span>
        <input type="text" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)}
          className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1" />
      </label>
      <p className="text-[var(--text-secondary)]">Only user prompts and final assistant replies are imported. Tool output, internal reasoning, and attachments are omitted. Review the source before importing sensitive content. This Chat stays private until you explicitly share it.</p>
      <button type="button" disabled={busy || Boolean(result)} onClick={() => void importChat()}
        className="rounded bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50">Import private Chat</button>
    </div> : null}
    {busy && !preview ? <p role="status">Reading transcript…</p> : null}
    {progress ? <p role="status">{progress}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <div role="status" className="space-y-2">
      <p>Imported {result.messageCount} {result.messageCount === 1 ? "message" : "messages"} into Matrix Chat.</p>
      {onOpenChat ? <button type="button" onClick={() => onOpenChat(result.chatId, title || preview?.title || "Imported Chat")}>Open Chat</button> : null}
    </div> : null}
  </section>;
}
