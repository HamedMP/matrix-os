import { lazy, Suspense } from "react";
import { FilePreviewContent } from "@matrix-os/ui";
import { DesktopPreviewText } from "./DesktopPreviewText";

const PdfViewer = lazy(() => import("./PdfViewer"));

export function DesktopFilePreviewContent(props: React.ComponentProps<typeof FilePreviewContent>) {
  return <FilePreviewContent {...props}
    renderText={(text) => <DesktopPreviewText descriptor={props.descriptor} text={text} />}
    renderPdf={(blob) => <Suspense fallback={<p role="status">Loading PDF…</p>}><PdfViewer blob={blob} name={props.descriptor.name} /></Suspense>}
  />;
}
