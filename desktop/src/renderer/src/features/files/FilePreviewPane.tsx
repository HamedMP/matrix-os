import {
  ArrowLeft,
  FileCode2,
  FileQuestion,
  Folder,
  LoaderCircle,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { lazy, useEffect, useState } from "react";
import { Button, EmptyState } from "../../design/primitives";
import { AppError, toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { isManagedBrowserPath, parseBrowserEntries, type BrowserEntry } from "./browser-entries";
import { FileGlyph, kindForEntry } from "./file-kind";
import { formatEntrySize, formatModified } from "./format";

const MarkdownContent = lazy(async () => {
  const module = await import("../editor/MarkdownPreview");
  return { default: module.MarkdownContent };
});

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
// Images stream through the authenticated client into renderer memory, so the
// bound matches the gateway blob body limit rather than the smaller text cap.
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

const TEXT_EXTENSIONS = [
  "txt", "json", "jsonl", "yaml", "yml", "toml", "xml", "csv", "log",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "sh",
  "bash", "zsh", "py", "rb", "go", "rs", "java", "kt", "sql", "env",
];
const TEXT_FILENAMES = ["dockerfile", "makefile", "procfile", "license", "notice"];

export interface FileSelection {
  slot: string;
  authGeneration: number;
  path: string;
  entry?: BrowserEntry;
}

export interface PreviewSelection {
  path: string;
  entry: BrowserEntry;
}

// A selection captured under one computer/session must never resolve to a
// preview under another. Scoped to both the runtime slot and the credential
// generation (a replacement session can keep the same slot).
export function resolveActivePath(
  selection: FileSelection | null,
  runtimeSlot: string,
  authGeneration: number,
): string | null {
  if (!selection) return null;
  if (selection.slot !== runtimeSlot || selection.authGeneration !== authGeneration) return null;
  return selection.path;
}

function isFiniteSizeWithin(size: unknown, max: number): boolean {
  return typeof size === "number" && Number.isFinite(size) && size <= max;
}

// The api client resolves the CURRENT runtime slot per request, so a preview
// that started under one computer/session must re-check the scope immediately
// before any follow-up fetch.
function captureConnectionScope(): string {
  const { runtimeSlot, authGeneration } = useConnection.getState();
  return `${runtimeSlot}|${authGeneration}`;
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

export type FilePreviewKind = "image" | "markdown" | "text" | "unsupported";

export function previewKindForPath(path: string): FilePreviewKind {
  if (isImage(path)) return "image";
  if (isMarkdown(path)) return "markdown";
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  if (TEXT_EXTENSIONS.includes(extension) || TEXT_FILENAMES.includes(name) || /^\.[a-z0-9_-]+$/.test(name)) {
    return "text";
  }
  return "unsupported";
}

interface PreviewFailureCopy {
  headline: string;
  description: string;
  kind: "missing" | "permission" | "recoverable";
}

function previewFailureCopy(error: unknown): PreviewFailureCopy {
  if (error instanceof Error && error.message === "file_too_large") {
    return {
      headline: "Preview too large",
      description: "This file is too large to preview.",
      kind: "recoverable",
    };
  }
  if (error instanceof AppError && error.category === "notFound") {
    return {
      headline: "File not found",
      description: "It may have been moved or deleted.",
      kind: "missing",
    };
  }
  if (
    error instanceof AppError &&
    error.category === "unauthorized" &&
    (error.detail === "permission_denied" || error.detail === "forbidden")
  ) {
    return {
      headline: "Permission required",
      description: "You don’t have permission to preview this file.",
      kind: "permission",
    };
  }
  return {
    headline: "Couldn’t load preview",
    description: toUserMessage(error),
    kind: "recoverable",
  };
}

function PreviewFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const copy = previewFailureCopy(error);
  const Icon = copy.kind === "permission" ? ShieldAlert : TriangleAlert;
  return (
    <EmptyState
      icon={<Icon size={26} />}
      headline={copy.headline}
      description={copy.description}
      action={<Button variant="subtle" onClick={onRetry}>Try again</Button>}
    />
  );
}

function LoadingPreview({ label = "Loading preview…" }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm" style={{ color: "var(--text-tertiary)" }}>
      <LoaderCircle size={16} className="animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

function TextPreview({ path, markdown = false }: { path: string; markdown?: boolean }) {
  const api = useConnection((state) => state.api);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; content: string } | { status: "error"; error: unknown }
  >({ status: "loading" });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const scope = captureConnectionScope();
    setState({ status: "loading" });
    void api.get<{ size?: number }>(`/api/files/stat?path=${encodeURIComponent(path)}`)
      .then(async (stat) => {
        if (!isFiniteSizeWithin(stat.size, MAX_TEXT_PREVIEW_BYTES)) throw new Error("file_too_large");
        if (cancelled || captureConnectionScope() !== scope) return null;
        return api.getText(`/api/files/blob?path=${encodeURIComponent(path)}`, { maxBytes: MAX_TEXT_PREVIEW_BYTES });
      })
      .then((content) => {
        if (!cancelled && content !== null) setState({ status: "ready", content });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      });
    return () => { cancelled = true; };
  }, [api, attempt, path]);

  if (state.status === "loading") return <LoadingPreview />;
  if (state.status === "error") return <PreviewFailure error={state.error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (markdown) return <MarkdownContent content={state.content} />;
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-5 font-mono text-[13px] leading-6" style={{ color: "var(--text-primary)", background: "var(--bg-sunken)" }} data-selectable>
      <code>{state.content}</code>
    </pre>
  );
}

function ImagePreview({ path, name }: { path: string; name: string }) {
  const api = useConnection((state) => state.api);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; url: string } | { status: "error"; error: unknown }
  >({ status: "loading" });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const scope = captureConnectionScope();
    setState({ status: "loading" });
    void api.get<{ size?: number }>(`/api/files/stat?path=${encodeURIComponent(path)}`)
      .then(async (stat) => {
        if (!isFiniteSizeWithin(stat.size, MAX_IMAGE_PREVIEW_BYTES)) throw new Error("file_too_large");
        if (cancelled || captureConnectionScope() !== scope) return null;
        return api.getBlob(`/api/files/blob?path=${encodeURIComponent(path)}`, { maxBytes: MAX_IMAGE_PREVIEW_BYTES });
      })
      .then((blob) => {
        if (cancelled || blob === null) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, attempt, path]);

  if (state.status === "loading") return <LoadingPreview />;
  if (state.status === "error") return <PreviewFailure error={state.error} onRetry={() => setAttempt((value) => value + 1)} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" style={{ background: "var(--bg-sunken)" }}>
      <img src={state.url} alt={name} className="max-h-full max-w-full rounded-lg object-contain" style={{ boxShadow: "var(--shadow-2)" }} />
    </div>
  );
}

function childBrowserPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function FolderPreview({
  path,
  onOpen,
}: {
  path: string;
  onOpen: (selection: PreviewSelection) => void;
}) {
  const api = useConnection((state) => state.api);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; entries: BrowserEntry[] } | { status: "error"; error: unknown }
  >({ status: "loading" });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const scope = captureConnectionScope();
    setState({ status: "loading" });
    void api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`)
      .then((response) => {
        if (!cancelled && captureConnectionScope() === scope) {
          setState({ status: "ready", entries: parseBrowserEntries(response.entries) });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      });
    return () => { cancelled = true; };
  }, [api, attempt, path]);

  if (state.status === "loading") return <LoadingPreview label="Loading folder…" />;
  if (state.status === "error") return <PreviewFailure error={state.error} onRetry={() => setAttempt((value) => value + 1)} />;
  if (state.entries.length === 0) {
    return <EmptyState icon={<Folder size={28} />} headline="This folder is empty" description="No files or folders inside." />;
  }
  return (
    <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(92px,1fr))] content-start gap-2 overflow-auto p-4">
      {state.entries.map((entry) => (
        <button
          type="button"
          key={`${entry.type}:${entry.name}`}
          aria-label={`Open ${entry.name} in preview`}
          className="flex min-w-0 flex-col items-center gap-2 rounded-lg border px-2 py-3 text-center transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-raised)" }}
          title={entry.name}
          onClick={() => onOpen({
            path: childBrowserPath(path, entry.name),
            entry,
          })}
        >
          <span style={{ color: entry.type === "directory" ? "var(--accent)" : "var(--text-tertiary)" }}>
            <FileGlyph kind={kindForEntry(entry)} size={28} />
          </span>
          <span className="w-full truncate text-xs" style={{ color: "var(--text-primary)" }}>{entry.name}</span>
        </button>
      ))}
    </div>
  );
}

// Renders below a Suspense boundary (markdown preview is lazy-loaded).
export function FilePreview({
  path,
  entry,
  onOpen,
}: {
  path: string | null;
  entry?: BrowserEntry;
  onOpen?: (selection: PreviewSelection) => void;
}) {
  const api = useConnection((state) => state.api);
  if (path === null || !api) {
    return <EmptyState icon={<FileCode2 size={26} />} headline="Choose a file" description="Preview images, Markdown, and code from this computer." />;
  }
  if (entry?.type === "directory") {
    return <FolderPreview key={path} path={path} onOpen={onOpen ?? (() => undefined)} />;
  }
  const name = path.split("/").pop() ?? path;
  const kind = previewKindForPath(path);
  if (kind === "image") return <ImagePreview key={path} path={path} name={name} />;
  if (kind === "markdown") return <TextPreview key={path} path={path} markdown />;
  if (kind === "text") return <TextPreview key={path} path={path} />;
  return <EmptyState icon={<FileQuestion size={26} />} headline="Preview not available" description="This file type can’t be previewed here." />;
}

export function PreviewPane({ selection }: { selection: PreviewSelection }) {
  const [history, setHistory] = useState<PreviewSelection[]>([selection]);
  const activeSelection = history.at(-1) ?? selection;
  const { entry, path } = activeSelection;

  useEffect(() => {
    setHistory([selection]);
  }, [selection.entry, selection.path]);

  const metadata = isManagedBrowserPath(path)
    ? "Managed · Read only"
    : entry.type === "directory"
    ? entry.children === undefined ? "Folder" : `${entry.children} ${entry.children === 1 ? "item" : "items"}`
    : [formatEntrySize(entry), formatModified(entry.modifiedAt)].filter((value) => value !== "–").join(" · ");
  return (
    <section
      aria-label="File preview"
      className="flex min-h-0 min-w-0 flex-col border-t md:border-t-0 md:border-l"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        {history.length > 1 ? (
          <button
            type="button"
            aria-label="Back in preview"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => setHistory((current) => current.slice(0, -1))}
          >
            <ArrowLeft size={16} aria-hidden />
          </button>
        ) : null}
        <span className="shrink-0" style={{ color: entry.type === "directory" ? "var(--accent)" : "var(--text-tertiary)" }}>
          <FileGlyph kind={kindForEntry(entry)} size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }} title={entry.name}>{entry.name}</h2>
          {metadata ? <p className="mt-0.5 truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{metadata}</p> : null}
        </div>
      </header>
      <FilePreview
        path={path}
        entry={entry}
        onOpen={(next) => setHistory((current) => [...current, next])}
      />
    </section>
  );
}
