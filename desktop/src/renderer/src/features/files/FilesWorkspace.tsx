import { FileCode2, FolderOpen, HardDrive } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { EmptyState } from "../../design/primitives";
import { buildGatewayUrl } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import ComputerFileBrowser from "./ComputerFileBrowser";

const MarkdownContent = lazy(async () => {
  const module = await import("../editor/MarkdownPreview");
  return { default: module.MarkdownContent };
});

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

function isMarkdown(path: string): boolean {
  return /\.mdx?$/i.test(path);
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
        if ((stat.size ?? 0) > MAX_TEXT_PREVIEW_BYTES) throw new Error("file_too_large");
        return api.getText(`/api/files/blob?path=${encodeURIComponent(path)}`);
      })
      .then((content) => {
        if (!cancelled) setState({ status: "ready", content });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", error: err instanceof Error && err.message === "file_too_large" ? "This file is too large to preview." : toUserMessage(err) });
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

function FilePreview({ path }: { path: string | null }) {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  if (!path || !api) {
    return <EmptyState icon={<FileCode2 size={26} />} headline="Choose a file" description="Preview images, Markdown, and code from this computer." />;
  }
  const name = path.split("/").pop() ?? path;
  if (isImage(path)) {
    const src = buildGatewayUrl(api.baseUrl, `/api/files/blob?path=${encodeURIComponent(path)}`, runtimeSlot);
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6" style={{ background: "var(--bg-sunken)" }}>
        <img src={src} alt={name} className="max-h-full max-w-full rounded-lg object-contain" style={{ boxShadow: "var(--shadow-2)" }} />
      </div>
    );
  }
  if (isMarkdown(path)) return <TextPreview path={path} markdown />;
  return <TextPreview path={path} />;
}

export default function FilesWorkspace() {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => setActivePath(null), [runtimeSlot]);

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
        <ComputerFileBrowser onOpenFile={setActivePath} />
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
