/** Export the open document as HTML, Markdown or plain text, as a download. */

import type { DocxDocument } from "../../../_shared/office-engine/index";
// The Word module alone keeps the workbook engine out of the Docs bundle.
import { toHtml, toMarkdown, toPlainText } from "../../../_shared/office-engine/docx/index";
import type { ViewMode } from "../editor/index";

export type ExportFormat = "html" | "markdown" | "text";

export interface ExportFile {
  fileName: string;
  mimeType: string;
  content: string;
}

const EXTENSIONS: Record<ExportFormat, string> = { html: ".html", markdown: ".md", text: ".txt" };
const MIME_TYPES: Record<ExportFormat, string> = { html: "text/html", markdown: "text/markdown", text: "text/plain" };

function baseName(name: string): string {
  const at = name.lastIndexOf(".");
  const stem = at > 0 ? name.slice(0, at) : name;
  return stem.trim() === "" ? "Document" : stem;
}

/**
 * HTML shows the current view (with markup in the markup view); Markdown and
 * plain text have no markup, so they take the final text unless the original
 * view is shown.
 */
export function buildExport(doc: DocxDocument, format: ExportFormat, viewMode: ViewMode, name: string): ExportFile {
  const stem = baseName(name);
  const textView = viewMode === "original" ? "original" : "final";
  let content: string;
  if (format === "html") content = toHtml(doc, { mode: viewMode, title: stem });
  else if (format === "markdown") content = toMarkdown(doc, { view: textView });
  else content = toPlainText(doc, { view: textView });
  return { fileName: `${stem}${EXTENSIONS[format]}`, mimeType: MIME_TYPES[format], content };
}

/** Hands the file to the browser as a download. */
export function downloadFile(file: ExportFile, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mimeType};charset=utf-8` }));
  const link = doc.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.rel = "noopener";
  link.style.display = "none";
  doc.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
