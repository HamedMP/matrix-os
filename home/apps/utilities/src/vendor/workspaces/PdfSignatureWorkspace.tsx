import { useEffect, useRef, useState } from "react";
import { FileCheck2, FileSearch, RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { inspectPdfSignatures } from "../lib/pdf-signature.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

type Signature = { fieldName: string; subFilter: string; integrity: "valid" | "invalid" | "unsupported"; coversWholeDocument: boolean; trust: "not_checked" };
type Report = { pageCount: number; signatures: Signature[]; notice: string };
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function track(action: "start" | "success" | "error", error?: unknown) {
  const event = toolEvent("check-pdf-signature", action, error);
  capturePostHogEvent(event.name, event.properties);
}

function signatureState(signature: Signature) {
  if (signature.integrity === "invalid") return { title: "Signature did not verify", detail: "The signed bytes or the signature data do not match.", Icon: ShieldAlert, color: "#991b1b", background: "#fef2f2" };
  if (signature.integrity === "unsupported") return { title: "Signature format not checked", detail: "This file uses a signature format or CMS profile outside this tool’s supported range.", Icon: ShieldQuestion, color: "#92400e", background: "#fffbeb" };
  if (!signature.coversWholeDocument) return { title: "Signed revision matches; later bytes exist", detail: "The signed part verifies, but more data follows it. This tool cannot judge whether those later changes are permitted or safe.", Icon: ShieldQuestion, color: "#92400e", background: "#fffbeb" };
  return { title: "Signed bytes match", detail: "The detached CMS signature verifies against the PDF bytes it covers. The signer’s identity and certificate trust have not been checked.", Icon: ShieldCheck, color: c.deep, background: "#e9f5ed" };
}

export function PdfSignatureWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const runId = useRef(0);
  useEffect(() => () => { controller.current?.abort(); runId.current++; }, []);

  function chooseFile(next: File | null) {
    controller.current?.abort();
    runId.current++;
    setFile(next);
    setReport(null);
    setError("");
    setBusy(false);
  }

  async function inspect() {
    track("start");
    setError(""); setReport(null);
    if (!file) { const cause = new Error("Choose a PDF first."); setError(cause.message); track("error", cause); return; }
    if (file.size > MAX_FILE_BYTES) { const cause = new Error("Choose a PDF of 25 MB or smaller."); setError(cause.message); track("error", cause); return; }
    const id = ++runId.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setBusy(true);
    try {
      const result = await inspectPdfSignatures(new Uint8Array(await file.arrayBuffer()), { signal: nextController.signal });
      if (runId.current !== id) return;
      setReport(result);
      track("success");
    } catch (cause) {
      if (runId.current !== id || nextController.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Could not inspect this PDF.");
      track("error", cause);
    } finally { if (runId.current === id) setBusy(false); }
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <section className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <div className="flex items-center gap-3"><span className="inline-flex size-12 items-center justify-center rounded-2xl" style={{ background: "#e9f5ed", color: c.deep }}><FileSearch className="size-6" /></span><div><h2 className="text-lg font-semibold" style={{ color: c.deep }}>Choose a signed PDF</h2><p className="text-sm" style={{ color: c.mutedFg }}>Check its embedded cryptographic signature in this browser.</p></div></div>
      <label htmlFor="pdf-signature-file" className="mt-6 block rounded-2xl border border-dashed p-6 text-center transition-colors hover:bg-green-50/40 focus-within:ring-2 focus-within:ring-offset-2" style={{ borderColor: `${c.deep}50`, "--tw-ring-color": c.deep } as React.CSSProperties} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files[0] ?? null); }}>
        <FileCheck2 className="mx-auto size-9" style={{ color: c.deep }} />
        <span className="mt-3 block text-sm font-semibold" style={{ color: c.deep }}>{file ? file.name : "Select or drop a PDF here"}</span>
        <span className="mt-1 block text-xs" style={{ color: c.mutedFg }}>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "Up to 25 MB · up to 200 pages · up to four signatures"}</span>
        <input id="pdf-signature-file" type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => { chooseFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
      </label>
      <div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={!file || busy} onClick={inspect} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><FileSearch className="size-4" />{busy ? "Checking…" : "Check signature"}</button><button type="button" disabled={!file && !report} onClick={() => chooseFile(null)} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30`, color: c.deep }}><RotateCcw className="size-4" /> Clear</button></div>
      {error && <p role="alert" className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-900">{error}</p>}
      <div className="mt-6 rounded-2xl p-4 text-xs leading-5" style={{ background: "#f1f5f0", color: c.mutedFg }}><strong style={{ color: c.deep }}>Private by design.</strong> Your PDF stays in this browser tab. This check does not upload the file, contact certificate authorities, or prove who signed it.</div>
    </section>
    <section className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }} aria-live="polite">
      <h2 className="text-lg font-semibold">Signature report</h2>
      {report ? <div className="mt-5 space-y-4">
        <p className="text-sm text-white/75">{report.pageCount} {report.pageCount === 1 ? "page" : "pages"} · {report.signatures.length} {report.signatures.length === 1 ? "signature" : "signatures"} found</p>
        {report.signatures.length ? report.signatures.map((signature, index) => { const state = signatureState(signature); return <article key={`${signature.fieldName}-${index}`} className="rounded-2xl p-5" style={{ color: state.color, background: state.background }}><div className="flex items-start gap-3"><state.Icon className="mt-0.5 size-6 shrink-0" /><div className="min-w-0"><h3 className="font-semibold">{state.title}</h3><p className="mt-1 break-words text-sm opacity-80">{signature.fieldName}</p><p className="mt-3 text-sm leading-6">{state.detail}</p><p className="mt-3 text-xs opacity-75">Format: {signature.subFilter} · Certificate trust: not checked</p></div></div></article>; }) : <div className="rounded-2xl border border-white/25 p-5"><ShieldQuestion className="size-7 text-white/75" /><p className="mt-3 font-semibold">No digital signature recognized</p><p className="mt-2 text-sm leading-6 text-white/70">A drawn or typed signature may appear on a page without cryptographically signing the PDF.</p></div>}
        <p className="pt-2 text-xs leading-5 text-white/65">{report.notice}</p>
      </div> : <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center"><ShieldQuestion className="size-10 text-white/45" /><p className="mt-4 max-w-xs text-sm leading-6 text-white/60">{busy ? "Checking the document’s signed bytes and embedded certificate…" : "Your signature check will appear here."}</p></div>}
    </section>
  </div>;
}
