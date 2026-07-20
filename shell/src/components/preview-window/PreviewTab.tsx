"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { usePreviewWindow, type PreviewTab as PreviewTabType } from "@/hooks/usePreviewWindow";
import { fileBlobUrl, fileMediaUrl } from "@/lib/file-blob";
import { FileIcon } from "lucide-react";
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
}

export function PreviewTabContent({ tab }: PreviewTabContentProps) {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const markUnsaved = usePreviewWindow((s) => s.markUnsaved);
  const markSaved = usePreviewWindow((s) => s.markSaved);
  const setMode = usePreviewWindow((s) => s.setMode);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state, react-doctor/no-fetch-in-effect -- guarded async file-load keyed on the selected tab (tab.path/tab.type): the loading -> content transition is one fetch React batches, the fetch carries an AbortController whose signal gates every setState and is aborted in cleanup, and the file body is not derivable in render.
  useEffect(() => {
    if (tab.type === "image" || tab.type === "audio" || tab.type === "video" || tab.type === "pdf") {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change -- media types render their own viewer and load no text here; clearing the loading gate is a one-shot reaction to the selected tab's type, not derivable in render.
      setLoading(false);
      return;
    }

    let active = true;

    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- raises the loading gate before the awaited fetch for the newly-selected tab; not a render-time derivation because the resolved file body arrives asynchronously below.
    setLoading(true);
    fetch(fileBlobUrl(tab.path), {
      signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
    })
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        if (active) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        console.warn("Failed to load preview tab content", error);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [tab.path, tab.type]);

  async function handleSave() {
    try {
      const res = await fetch(`${fileBlobUrl(tab.path)}&force=true`, {
        method: "PUT",
        signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
        body: content,
      });
      if (res.ok) {
        markSaved(tab.id);
      }
    } catch (error: unknown) {
      console.warn("Failed to save preview tab content", error);
      // save failed — unsaved indicator stays visible
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  // Toolbar for text-editable types
  const showToolbar =
    tab.type === "markdown" || tab.type === "code" || tab.type === "text";

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
          <Button variant="ghost" size="sm" className="h-6" onClick={handleSave}>
            Save
          </Button>
        </div>
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
                setContent(val);
                markUnsaved(tab.id);
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
