import { FileCode2, FolderOpen, HardDrive } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "./ComputerFileBrowser";

const MarkdownContent = lazy(async () => {
  const module = await import("../editor/MarkdownPreview");
  return { default: module.MarkdownContent };
});

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
// Images stream through the authenticated client into renderer memory, so the
// bound matches the gateway blob body limit rather than the smaller text cap.
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

export interface FileSelection {
  slot: string;
  authGeneration: number;
  path: string;
}

// A selection captured under one computer/session must never resolve to a
// preview under another. Scoped to both the runtime slot and the credential
// generation (a replacement session can keep the same slot). Derived
// synchronously so a switch clears the path in the same render, before any
// stat/blob request can target the new computer or owner.
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

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

function previewErrorMessage(err: unknown): string {
  return err instanceof Error && err.message === "file_too_large"
    ? "This file is too large to preview."
    : toUserMessage(err);
}

function TextPreview({ path, markdown = false }: { path: string; markdown?: boolean }) {
  const api = useConnection((state) => state.api);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; content?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    setState({ status: "loading" });
    void api.get<{ size?: number }>(`/api/files/stat?path=${encodeURIComponent(path)}`)
      .then(async (stat) => {
        // Fail closed: a missing or non-finite size must not bypass the bound.
        if (!isFiniteSizeWithin(stat.size, MAX_TEXT_PREVIEW_BYTES)) throw new Error("file_too_large");
        // The selected computer may have changed while stat was in flight; the
        // api client resolves the CURRENT runtime slot per request, so fetching
        // now would read this path from the newly selected computer. Bail first.
        if (cancelled) return null;
        return api.getText(`/api/files/blob?path=${encodeURIComponent(path)}`);
      })
      .then((content) => {
        if (!cancelled && content !== null) setState({ status: "ready", content });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", error: previewErrorMessage(err) });
      });
    return () => { cancelled = true; };
  }, [api, path]);

  if (state.status === "loading") return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>;
  if (state.status === "error") return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--danger)" }}>{state.error}</div>;
  if (markdown) return <MarkdownContent content={state.content ?? ""} />;
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-5 font-mono text-[13px] leading-6" style={{ color: "var(--text-primary)", background: "var(--bg-sunken)" }} data-selectable>
      <code>{state.content}</code>
    </pre>
  );
}

function ImagePreview({ path, name }: { path: string; name: string }) {
  const api = useConnection((state) => state.api);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; url?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void api.get<{ size?: number }>(`/api/files/stat?path=${encodeURIComponent(path)}`)
      .then(async (stat) => {
        // Fail closed like text previews: bound the bytes read into renderer memory.
        if (!isFiniteSizeWithin(stat.size, MAX_IMAGE_PREVIEW_BYTES)) throw new Error("file_too_large");
        // The selected computer may have changed while stat was in flight; the
        // api client resolves the CURRENT runtime slot per request, so fetching
        // now would read this path from the newly selected computer. Bail first.
        if (cancelled) return null;
        // Load bytes through the authenticated client so credentials injected at
        // the network layer apply. A bare <img src> to the blob route cannot
        // carry them and would expose the selected computer's file by URL.
        return api.getBlob(`/api/files/blob?path=${encodeURIComponent(path)}`);
      })
      .then((blob) => {
        if (cancelled || blob === null) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", error: previewErrorMessage(err) });
      });
    return () => {
      cancelled = true;
      // Revoke on path change/unmount so object URLs never leak.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);

  if (state.status === "loading") return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>;
  if (state.status === "error") return <div className="flex flex-1 items-center justify-center text-sm" style={{ color: "var(--danger)" }}>{state.error}</div>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" style={{ background: "var(--bg-sunken)" }}>
      <img src={state.url} alt={name} className="max-h-full max-w-full rounded-lg object-contain" style={{ boxShadow: "var(--shadow-2)" }} />
    </div>
  );
}

function FilePreview({ path }: { path: string | null }) {
  const api = useConnection((state) => state.api);
  if (!path || !api) {
    return <EmptyState icon={<FileCode2 size={26} />} headline="Choose a file" description="Preview images, Markdown, and code from this computer." />;
  }
  const name = path.split("/").pop() ?? path;
  // key={path} remounts the preview when the file changes so its loading state
  // resets synchronously, instead of showing the previous file until the effect
  // runs after paint.
  if (isImage(path)) return <ImagePreview key={path} path={path} name={name} />;
  if (isMarkdown(path)) return <TextPreview key={path} path={path} markdown />;
  return <TextPreview key={path} path={path} />;
}

export default function FilesWorkspace() {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const [selection, setSelection] = useState<FileSelection | null>(null);

  // Correctness comes from this synchronous derivation, not the effect below:
  // a selection made under another computer/session resolves to null on the
  // first render with the new slot or generation, so FilePreview never sees a
  // stale path.
  const activePath = resolveActivePath(selection, runtimeSlot, authGeneration);

  useEffect(() => {
    setSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [runtimeSlot, authGeneration]);

  const handleOpenFile = useCallback(
    (path: string) => setSelection({ slot: runtimeSlot, authGeneration, path }),
    [runtimeSlot, authGeneration],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-app)" }}>
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-5" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "var(--accent-muted)", color: "var(--accent)" }}><FolderOpen size={17} /></span>
          <div>
            <h1 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Files</h1>
            <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>Browse and preview your Matrix computer</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-tertiary)" }}>
          <HardDrive size={13} />
          <span>{handle ?? "Matrix computer"}</span>
          {runtimeSlot !== "primary" ? <span>· {runtimeSlot}</span> : null}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(220px,40%)_minmax(0,1fr)] gap-3 p-3 md:grid-cols-[minmax(260px,360px)_minmax(0,1fr)] md:grid-rows-1">
        <ComputerFileBrowser onOpenFile={handleOpenFile} />
        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border" style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}>
          <div className="flex h-10 shrink-0 items-center border-b px-3 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
            <span className="truncate" title={activePath ?? undefined}>{activePath ?? "Preview"}</span>
          </div>
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-xs" style={{ color: "var(--text-tertiary)" }}>Loading preview…</div>}>
            <FilePreview path={activePath} />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
