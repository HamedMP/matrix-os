import { lazy, Suspense } from "react";
import { FilePreviewContent } from "@matrix-os/ui";
import { DesktopPreviewText } from "./DesktopPreviewText";
import type { PreviewKind } from "@matrix-os/contracts";
import type { ReactNode } from "react";

const PdfViewer = lazy(() => import("./PdfViewer"));

export function DesktopFilePreviewViewport({ kind, children }: { kind: PreviewKind; children: ReactNode }) {
  const media = kind === "image" || kind === "audio" || kind === "video";
  return <div data-file-preview-viewport className={media
    ? "flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-4"
    : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>{children}</div>;
}

export function DesktopFilePreviewContent(props: React.ComponentProps<typeof FilePreviewContent>) {
  return <FilePreviewContent {...props}
    renderText={(text) => <DesktopPreviewText descriptor={props.descriptor} text={text} />}
    renderPdf={(blob) => <Suspense fallback={<p role="status">Loading PDF…</p>}><PdfViewer blob={blob} name={props.descriptor.name} /></Suspense>}
  />;
}
