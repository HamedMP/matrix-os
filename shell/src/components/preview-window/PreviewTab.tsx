"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { previewFileRequestSignal, usePreviewWindow, type PreviewTab as PreviewTabType } from "@/hooks/usePreviewWindow";
import { fileBlobUrl, fileMediaUrl } from "@/lib/file-blob";
import { FileIcon } from "@/lib/hugeicons";
import { Button } from "@/components/ui/button";

const CodeEditor = lazy(() =>
  import("./CodeEditor").then((m) => ({ default: m.CodeEditor })),
);
const MarkdownViewer = lazy(() =>
  import("./MarkdownViewer").then((m) => ({ default: m.MarkdownViewer })),
);
const ImageViewer = lazy(() =>
  import("./ImageViewer").then((m) => ({ default: m.ImageViewer })),
);
const MediaPlayer = lazy(() =>
  import("./MediaPlayer").then((m) => ({ default: m.MediaPlayer })),
);

interface PreviewTabContentProps {
  tab: PreviewTabType;
  authority: string;
}

type FileLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; url: string; content: string };

export function isEditablePreviewTab(tab: PreviewTabType): boolean {
  return tab.type === "markdown" || tab.type === "code" || tab.type === "text";
}

export function PreviewTabContent(props: PreviewTabContentProps) {
  const { tab, authority } = props;
  return <PreviewTabFile key={JSON.stringify([tab.id, tab.path, tab.type, authority])} {...props} />;
}

function PreviewTabFile({ tab, authority }: PreviewTabContentProps) {
  const draft = usePreviewWindow((s) => s.draftAuthority === authority
    ? s.drafts.find(item => item.tabId === tab.id) : undefined);
  const saved = usePreviewWindow((s) => s.draftAuthority === authority && s.lastSavedTabId === tab.id);
  const [load, setLoad] = useState<FileLoad>(() => draft
    ? { kind: "ready", url: draft.url, content: draft.content } : { kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const setMode = usePreviewWindow((s) => s.setMode);

  const showToolbar = isEditablePreviewTab(tab);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the file body is fetched for this mounted tab, and both request and state updates are scoped to that tab's lifetime.
  useEffect(() => {
    if (!showToolbar) return;
    const current = usePreviewWindow.getState();
    if (current.draftAuthority === authority && current.drafts.some(item => item.tabId === tab.id)) return;
    const controller = new AbortController();
    const url = fileBlobUrl(tab.path);

    async function open() {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          redirect: "error",
          signal: previewFileRequestSignal(controller),
        });
        if (!response.ok) {
          if (!controller.signal.aborted) setLoad({ kind: "failed" });
          return;
        }
        const content = await response.text();
        if (controller.signal.aborted) return;
        setLoad({ kind: "ready", url, content });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        console.warn("[preview] File could not be opened:", error instanceof Error ? error.name : "unknown");
        setLoad({ kind: "failed" });
      }
    }

    void open();
    return () => controller.abort();
  }, [tab.id, tab.path, authority, showToolbar, attempt]);

  if (showToolbar && load.kind === "loading") {
    return (
      <div role="status" className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (showToolbar && load.kind === "failed") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
        <p role="alert">Could not open this file.</p>
        <Button variant="outline" size="sm" onClick={() => {
          setLoad({ kind: "loading" });
          setAttempt(current => current + 1);
        }}>
          Retry
        </Button>
      </div>
    );
  }

  const content = draft?.content ?? (load.kind === "ready" ? load.content : "");

  return (
    <div className="flex flex-col h-full">
      {showToolbar && (
        <div className="flex items-center gap-2 px-3 py-1 border-b text-xs">
          {tab.type === "markdown" && (
            <div className="flex items-center border rounded-md">
              {(["source", "preview"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`px-2 py-0.5 ${tab.mode === m ? "bg-accent" : ""}`}
                  onClick={() => setMode(tab.id, m)}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          )}
          <div className="flex-1" />
          <span className="text-muted-foreground">{tab.name}</span>
          {saved && <span role="status" className="text-muted-foreground">Saved</span>}
          <Button variant="ghost" size="sm" className="h-6"
            onClick={() => { void usePreviewWindow.getState().saveDraft(tab.id, authority); }}
            disabled={!draft || draft.status === "saving"}>
            {draft?.status === "saving" ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
      {draft?.status === "failed" && (
        <p role="alert" className="border-b px-3 py-2 text-sm text-destructive">
          Could not save this file. Your changes are still here.
        </p>
      )}

      <div className="flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Loading viewer...
            </div>
          }
        >
          {tab.type === "image" ? (
            <ImageViewer path={tab.path} />
          ) : tab.type === "audio" || tab.type === "video" ? (
            <MediaPlayer path={tab.path} type={tab.type} />
          ) : tab.type === "pdf" ? (
            <PdfPlaceholder path={tab.path} />
          ) : tab.type === "markdown" && tab.mode === "preview" ? (
            <MarkdownViewer content={content} sourcePath={tab.path} />
          ) : (
            <CodeEditor
              content={content}
              filename={tab.name}
              onChange={(val) => {
                if (load.kind === "ready" && val !== content
                  && usePreviewWindow.getState().changeDraft(tab.id, authority, load.url, val)) {
                  setLoad({ ...load, content: val });
                }
              }}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}

function PdfPlaceholder({ path }: { path: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
      <FileIcon className="size-12" />
      <div className="text-sm font-medium">PDF Preview</div>
      <div className="text-xs">
        PDF rendering requires pdfjs-dist (planned for v2)
      </div>
      <a
        href={fileMediaUrl(path)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary underline"
      >
        Open in browser
      </a>
    </div>
  );
}
