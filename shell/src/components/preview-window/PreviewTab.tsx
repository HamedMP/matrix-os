"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { usePreviewWindow, type PreviewTab as PreviewTabType } from "@/hooks/usePreviewWindow";
import { getGatewayUrl } from "@/lib/gateway";
import { FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const GATEWAY_URL = getGatewayUrl();

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

  useEffect(() => {
    if (tab.type === "image" || tab.type === "audio" || tab.type === "video" || tab.type === "pdf") {
      setLoading(false);
      return;
    }

    setLoading(true);
    fetch(`${GATEWAY_URL}/files/${tab.path}`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [tab.path, tab.type]);

  async function handleSave() {
    try {
      const res = await fetch(`${GATEWAY_URL}/files/${tab.path}`, {
        method: "PUT",
        body: content,
      });
      if (res.ok) {
        markSaved(tab.id);
      }
    } catch {
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
            <MarkdownViewer content={content} />
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
        href={`${GATEWAY_URL}/files/${path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary underline"
      >
        Open in browser
      </a>
    </div>
  );
}
