"use client";

import { useState, useEffect, useLayoutEffect, useRef, lazy, Suspense } from "react";
import { usePreviewWindow, type PreviewTab as PreviewTabType } from "@/hooks/usePreviewWindow";
import { fileBlobUrl, fileMediaUrl } from "@/lib/file-blob";
import { FileIcon } from "@/lib/hugeicons";
import { Button } from "@/components/ui/button";

const FILE_FETCH_TIMEOUT_MS = 10_000;

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
  onDirtyChange?: (id: string, dirty: boolean) => void;
}

type FileLoad =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; url: string; content: string };

type SaveState = "idle" | "saving" | "failed" | "saved";

function fileRequestSignal(controller: AbortController): AbortSignal {
  return AbortSignal.any([controller.signal, AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS)]);
}

export function isEditablePreviewTab(tab: PreviewTabType): boolean {
  return tab.type === "markdown" || tab.type === "code" || tab.type === "text";
}

export function PreviewTabContent(props: PreviewTabContentProps) {
  const { tab } = props;
  return <PreviewTabFile key={JSON.stringify([tab.id, tab.path, tab.type, tab.authority])} {...props} />;
}

function PreviewTabFile({ tab, onDirtyChange }: PreviewTabContentProps) {
  const [load, setLoad] = useState<FileLoad>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const draft = useRef("");
  const saveRequest = useRef<AbortController | null>(null);
  const markUnsaved = usePreviewWindow((s) => s.markUnsaved);
  const markSaved = usePreviewWindow((s) => s.markSaved);
  const setMode = usePreviewWindow((s) => s.setMode);
  const [dirty, setDirty] = useState(false);

  const showToolbar = isEditablePreviewTab(tab);

  useLayoutEffect(() => () => {
    saveRequest.current?.abort();
    if (usePreviewWindow.getState().unsavedTabs.has(tab.id)) markSaved(tab.id);
  }, [tab.id, markSaved]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the file body is fetched for this mounted tab, and both request and state updates are scoped to that tab's lifetime.
  useEffect(() => {
    if (!showToolbar) return;
    const controller = new AbortController();
    const url = fileBlobUrl(tab.path);

    async function open() {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          redirect: "error",
          signal: fileRequestSignal(controller),
        });
        if (!response.ok) {
          if (!controller.signal.aborted) setLoad({ kind: "failed" });
          return;
        }
        const content = await response.text();
        if (controller.signal.aborted) return;
        draft.current = content;
        setLoad({ kind: "ready", url, content });
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        console.warn("[preview] File could not be opened:", error instanceof Error ? error.name : "unknown");
        setLoad({ kind: "failed" });
      }
    }

    void open();
    return () => controller.abort();
  }, [tab.path, showToolbar, attempt]);

  async function handleSave() {
    if (load.kind !== "ready" || !dirty || saveRequest.current) return;
    if (fileBlobUrl(tab.path) !== load.url) {
      setSaveState("failed");
      return;
    }

    const controller = new AbortController();
    saveRequest.current = controller;
    const savedContent = draft.current;
    setSaveState("saving");
    try {
      const response = await fetch(`${load.url}&force=true`, {
        method: "PUT",
        redirect: "error",
        signal: fileRequestSignal(controller),
        body: savedContent,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setSaveState("failed");
        return;
      }
      if (draft.current === savedContent) {
        setDirty(false);
        markSaved(tab.id);
        onDirtyChange?.(tab.id, false);
        setSaveState("saved");
      } else {
        setSaveState("idle");
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      console.warn("[preview] File could not be saved:", error instanceof Error ? error.name : "unknown");
      setSaveState("failed");
    } finally {
      saveRequest.current = null;
    }
  }

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

  const content = load.kind === "ready" ? load.content : "";

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
          {saveState === "saved" && <span role="status" className="text-muted-foreground">Saved</span>}
          <Button variant="ghost" size="sm" className="h-6" onClick={handleSave}
            disabled={!dirty || saveState === "saving"}>
            {saveState === "saving" ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
      {saveState === "failed" && (
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
                if (load.kind !== "ready" || val === draft.current) return;
                draft.current = val;
                setLoad({ ...load, content: val });
                if (saveState === "saved") setSaveState("idle");
                setDirty(true);
                markUnsaved(tab.id);
                onDirtyChange?.(tab.id, true);
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
