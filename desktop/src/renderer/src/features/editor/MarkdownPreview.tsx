import ReactMarkdown from "react-markdown";
import { useEffect, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { createFilesApi, openFile } from "./editor-save";

// Read-only rendered markdown for .md/.mdx files. Reuses the chat response prose
// styling so docs read like docs instead of raw CodeMirror text. Toggle to Code
// in the editor header to edit.
export default function MarkdownPreview({ path }: { path: string }) {
  const api = useConnection((s) => s.api);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    void openFile(createFilesApi(api), path)
      .then((file) => {
        if (!cancelled) setContent(file.content);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toUserMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, path]);

  if (error) {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--danger)" }}>{error}</div>;
  }
  if (content === null) {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading…</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div
        className="prose-sm mx-auto max-w-[760px] text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-[var(--border-subtle)] [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--bg-sunken)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_ul]:list-disc [&_ul]:pl-5"
        style={{ color: "var(--text-primary)" }}
        data-selectable
      >
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
