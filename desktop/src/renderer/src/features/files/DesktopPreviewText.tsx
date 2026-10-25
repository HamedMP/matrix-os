import { lazy, Suspense } from "react";
import type { FilePreviewDescriptor } from "@matrix-os/contracts";
import { MonacoReadOnlyEditor } from "../editor/MonacoReadOnlyEditor";

const MarkdownContent = lazy(async () => {
  const module = await import("../editor/MarkdownPreview");
  return { default: module.MarkdownContent };
});

export function DesktopPreviewText({ descriptor, text }: { descriptor: FilePreviewDescriptor; text: string }) {
  return <Suspense fallback={<p role="status">Loading preview…</p>}>
    {descriptor.kind === "markdown" ? <MarkdownContent content={text} />
      : <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"><MonacoReadOnlyEditor path={descriptor.name} content={text} /></div>}
  </Suspense>;
}
