import { ImportPreviewError, MAX_IMPORT_PREVIEW_BYTES, parseSelectedImportPreview } from "@matrix-os/contracts/selected-import-preview";
import type { FilePreviewDescriptor } from "@matrix-os/contracts";
import { useEffect, useState } from "react";

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const TEXTUAL_PREVIEW_KINDS: ReadonlyArray<FilePreviewDescriptor["kind"]> = ["text", "markdown", "table", "html"];

export interface FilePreviewContentProps {
  descriptor: FilePreviewDescriptor;
  contentUrl: string;
  loadBlob?: (url: string, maxBytes: number) => Promise<Blob>;
  loadText?: (url: string, maxBytes: number) => Promise<string>;
  retry?: () => void;
  /** A caller that supplies a bounded prefix rather than the complete text. */
  textPreviewBytes?: number;
}

function Loading() {
  return <p role="status" className="p-4 text-sm">Loading preview…</p>;
}

function Failure({ retry }: { retry?: () => void }) {
  return <div role="alert" className="p-4 text-sm">
    File preview unavailable.
    {retry ? <button type="button" className="ml-2 underline" onClick={retry}>Retry</button> : null}
  </div>;
}

function TextualPreview({ descriptor, contentUrl, loadText, retry, textPreviewBytes }: FilePreviewContentProps) {
  const maximum = descriptor.kind === "table" ? MAX_IMPORT_PREVIEW_BYTES : MAX_TEXT_BYTES;
  const limit = textPreviewBytes === undefined ? maximum : Math.max(1, Math.min(maximum, textPreviewBytes));
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; text: string } | { status: "failed" }>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    if (!loadText || (textPreviewBytes === undefined && descriptor.sizeBytes > limit)) {
      setState({ status: "failed" });
      return () => { active = false; };
    }
    void loadText(contentUrl, limit).then((text) => {
      if (active) setState({ status: "ready", text });
    }).catch((error: unknown) => {
      console.warn("[file-preview] text load failed", error instanceof Error ? error.name : "UnknownError");
      if (active) setState({ status: "failed" });
    });
    return () => { active = false; };
  }, [contentUrl, descriptor.sizeBytes, loadText, limit, textPreviewBytes]);
  if (state.status === "loading") return <Loading />;
  if (state.status === "failed") return <Failure retry={retry} />;
  if (descriptor.kind === "table") {
    try {
      const preview = parseSelectedImportPreview(descriptor.name, state.text);
      if (preview.kind !== "table") return <Failure retry={retry} />;
      return <TablePreview name={descriptor.name} rows={[preview.columns, ...preview.rows]} truncated={preview.truncated} />;
    } catch (error) {
      if (!(error instanceof ImportPreviewError)) throw error;
      return <Failure retry={retry} />;
    }
  }
  if (descriptor.kind === "html") {
    const policy = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:";
    return <iframe
      title={`HTML preview: ${descriptor.name}`}
      sandbox=""
      srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${state.text}`}
      className="h-full min-h-96 w-full border-0 bg-white"
    />;
  }
  return <div className="min-h-0 w-full overflow-auto">
    <pre className="whitespace-pre-wrap break-words p-4 text-xs" data-selectable><code>{state.text}</code></pre>
    {descriptor.sizeBytes > limit ? <p role="status" className="px-4 pb-4 text-xs">Preview truncated.</p> : null}
  </div>;
}

function TablePreview({ name, rows, truncated }: { name: string; rows: string[][]; truncated: boolean }) {
  const [header = [], ...body] = rows;
  return <div className="min-h-0 overflow-auto p-4">
    <table aria-label={name} className="w-full border-collapse text-left text-xs">
      <thead><tr>{header.map((cell, index) => <th key={index} className="border px-2 py-1 font-semibold">{cell}</th>)}</tr></thead>
      <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border px-2 py-1">{cell}</td>)}</tr>)}</tbody>
    </table>
    {truncated ? <p role="status" className="pt-2 text-xs">Preview truncated after 100 rows.</p> : null}
  </div>;
}

function BinaryPreview({ descriptor, contentUrl, loadBlob, retry }: FilePreviewContentProps) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; url: string } | { status: "failed" }>({ status: "loading" });
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setState({ status: "loading" });
    if (!loadBlob || descriptor.sizeBytes > MAX_BINARY_BYTES) {
      setState({ status: "failed" });
      return () => { active = false; };
    }
    void loadBlob(contentUrl, MAX_BINARY_BYTES).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ status: "ready", url: objectUrl });
    }).catch((error: unknown) => {
      console.warn("[file-preview] binary load failed", error instanceof Error ? error.name : "UnknownError");
      if (active) setState({ status: "failed" });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contentUrl, descriptor.sizeBytes, loadBlob]);
  if (state.status === "loading") return <Loading />;
  if (state.status === "failed") return <Failure retry={retry} />;
  if (descriptor.kind === "image") return <img src={state.url} alt={descriptor.name} className="max-h-full max-w-full object-contain" />;
  if (descriptor.kind === "audio") return <audio controls preload="metadata" aria-label={`Audio preview: ${descriptor.name}`} src={state.url} className="w-full max-w-xl" />;
  if (descriptor.kind === "video") return <video controls preload="metadata" aria-label={`Video preview: ${descriptor.name}`} src={state.url} className="max-h-full max-w-full" />;
  return <object aria-label={`Document preview: ${descriptor.name}`} data={state.url} type="application/pdf" className="h-full min-h-96 w-full">
    <p>PDF preview unavailable.</p>
  </object>;
}

export function FilePreviewContent(props: FilePreviewContentProps) {
  if (TEXTUAL_PREVIEW_KINDS.includes(props.descriptor.kind)) return <TextualPreview {...props} />;
  if (["image", "pdf", "audio", "video"].includes(props.descriptor.kind)) return <BinaryPreview {...props} />;
  return <p className="p-4 text-sm">This file type does not support a preview.</p>;
}
