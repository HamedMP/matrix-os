import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useEffect, useState } from "react";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { createFilesApi, openFile } from "./editor-save";

type PreviewState =
  | { path: string; status: "loading" }
  | { path: string; status: "ready"; content: string }
  | { path: string; status: "error"; error: string };

export function safeUrlTransform(url: string): string {
  try {
    const parsed = new URL(url, "https://matrix.local");
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return url;
    }
  } catch {
    return "";
  }
  return "";
}

export const MARKDOWN_PREVIEW_CLASS_NAME =
  "prose-sm mx-auto max-w-[760px] text-sm leading-relaxed [&_a]:text-[var(--highlight)] [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-default)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--bg-sunken)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-[var(--border-subtle)] [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--bg-sunken)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:bg-[var(--bg-sunken)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5 [&_ul.contains-task-list]:!list-none [&_li.task-list-item]:!list-none [&_input]:mr-1.5";

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className={MARKDOWN_PREVIEW_CLASS_NAME} style={{ color: "var(--text-primary)" }} data-selectable>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
          urlTransform={safeUrlTransform}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// Read-only rendered markdown for .md/.mdx files. Reuses the chat response prose
// styling so docs read like docs instead of raw CodeMirror text. Toggle to Code
// in the editor header to edit.
export default function MarkdownPreview({ path }: { path: string }) {
  const api = useConnection((s) => s.api);
  const [state, setState] = useState<PreviewState>(() => ({ path, status: "loading" }));
  const preview: PreviewState = state.path === path ? state : { path, status: "loading" };

  useEffect(() => {
    setState({ path, status: "loading" });
    if (!api) return undefined;
    let cancelled = false;
    const requestedPath = path;
    void openFile(createFilesApi(api), path)
      .then((file) => {
        if (!cancelled) setState({ path: requestedPath, status: "ready", content: file.content });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ path: requestedPath, status: "error", error: toUserMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, path]);

  if (preview.status === "error") {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--danger)" }}>{preview.error}</div>;
  }
  if (preview.status === "loading") {
    return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading…</div>;
  }

  return <MarkdownContent content={preview.content} />;
}
