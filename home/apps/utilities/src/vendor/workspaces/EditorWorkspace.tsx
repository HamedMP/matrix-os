import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Plus, Play, RotateCcw } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { exportCsvPdf, parseEditableCsv, serializeEditableCsv, textStats } from "../lib/editor-tools.mjs";
import { csvWindow } from "../lib/workspace-tools.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

const initialCsv = "Name,Role\nAda,Engineer\nLin,Designer";
const initialMd = "# Matrix notes\n\nA **clear** browser editor.\n\n- Write\n- Preview\n- Download";
const initialText = "Matrix tools help with small tasks in your browser.";
const field = "w-full min-w-0 rounded-xl border p-3 text-sm outline-none focus:ring-2";

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EditorWorkspace({ slug }: { slug: string }) {
  const csvMode = slug === "csv-editor" || slug === "csv-to-pdf";
  const markdown = slug === "markdown-editor";
  const [text, setText] = useState(csvMode ? initialCsv : markdown ? initialMd : initialText);
  const [rows, setRows] = useState<string[][]>(() => csvMode ? parseEditableCsv(initialCsv) : []);
  const [rowPage, setRowPage] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const tableWindow = useMemo(() => csvWindow(rows, rowPage, columnPage), [rows, rowPage, columnPage]);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState("");
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const version = useRef(0);
  const previewVersion = useRef(0);
  useEffect(() => () => { version.current++; }, []);
  const stats = useMemo(() => textStats(text), [text]);

  function invalidateTextResult() {
    setResult(""); setCompleted(false); setCopied(false);
  }

  useEffect(() => {
    if (!markdown) return;
    let live = true;
    const current = ++previewVersion.current;
    const timer = window.setTimeout(async () => {
      try {
        const [{ marked }, dompurify] = await Promise.all([import("marked"), import("dompurify")]);
        const raw = await marked.parse(text.slice(0, 50_000), { gfm: true, breaks: true });
        if (live && previewVersion.current === current) setPreview(dompurify.default.sanitize(raw, { USE_PROFILES: { html: true } }));
      } catch (cause) { if (live && previewVersion.current === current) { reportToolFailure(cause); setError("Could not render this Markdown preview."); } }
    }, 200);
    return () => { live = false; previewVersion.current++; window.clearTimeout(timer); };
  }, [markdown, text]);

  function parseCsv() {
    version.current++; setBusy(false); setLoadingCsv(false);
    setError(""); setNotice(""); track(slug, "start");
    try { const parsed = parseEditableCsv(text); setRows(parsed); setRowPage(0); setColumnPage(0); track(slug, "success"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not parse this CSV."); track(slug, "error", cause); }
  }

  function updateCell(ri: number, ci: number, value: string) {
    version.current++; setBusy(false); setLoadingCsv(false); setNotice("");
    setRows((current) => current.map((row, index) => index === ri ? row.map((cell, column) => column === ci ? value.slice(0, 10_000) : cell) : row));
  }

  function exportCsv() {
    try { download(serializeEditableCsv(rows), "edited-table.csv", "text/csv;charset=utf-8"); track(slug, "download"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export this table."); track(slug, "error", cause); }
  }

  async function exportPdf() {
    const current = ++version.current;
    setError(""); setBusy(true); track(slug, "start");
    try {
      const data = rows.length ? rows : parseEditableCsv(text);
      const output = await exportCsvPdf(data);
      if (version.current !== current) return;
      download(new Uint8Array(output.bytes), output.filename, output.mime);
      setNotice(output.notice); track(slug, "success"); track(slug, "download");
    } catch (cause) { if (version.current === current) { setError(cause instanceof Error ? cause.message : "Could not make this PDF."); track(slug, "error", cause); } }
    finally { if (version.current === current) { setBusy(false); setLoadingCsv(false); } }
  }

  function finishCsvImport(current: number) {
    if (version.current === current) { setBusy(false); setLoadingCsv(false); }
  }

  async function importCsvFile(file?: File) {
    if (!file) return;
    const current = ++version.current; setBusy(false); setLoadingCsv(false); setError(""); setNotice("");
    if (file.size > 200_000) { setError("CSV file must be 200 KB or smaller."); return; }
    setBusy(true); setLoadingCsv(true);
    let sourceRead = false;
    try {
      const source = await file.text(); if (version.current !== current) return;
      sourceRead = true; const parsed = parseEditableCsv(source);
      setText(source); setRows(parsed); setRowPage(0); setColumnPage(0);
      finishCsvImport(current);
    } catch (cause) {
      reportToolFailure(cause);
      if (version.current === current) setError(sourceRead && cause instanceof Error ? cause.message : "Could not open this CSV file.");
      finishCsvImport(current);
    }
  }

  async function copy() {
    const current = version.current;
    try { await navigator.clipboard.writeText(result); if (version.current !== current) return; setCopied(true); track(slug, "copy"); window.setTimeout(() => { if (version.current === current) setCopied(false); }, 1500); }
    catch (cause) { if (version.current === current) { setError("Could not copy automatically. Select the result instead."); track(slug, "error", cause); } }
  }

  function changeText(action: "upper" | "lower" | "trim" | "sort") {
    version.current++; setCopied(false);
    track(slug, "start");
    const value = action === "upper" ? text.toUpperCase() : action === "lower" ? text.toLowerCase() : action === "sort" ? text.split("\n").sort((a, b) => a.localeCompare(b)).join("\n") : text.split("\n").map((line) => line.trim()).join("\n").trim();
    setResult(value); setCompleted(true); track(slug, "success");
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <label htmlFor="editor-input" className="block font-semibold">{csvMode ? "CSV source" : markdown ? "Markdown source" : "Your text"}</label>
      <textarea id="editor-input" value={text} onChange={(event) => { version.current++; previewVersion.current++; setBusy(false); setLoadingCsv(false); invalidateTextResult(); setPreview(""); setText(event.target.value); setRows([]); setRowPage(0); setColumnPage(0); setError(""); setNotice(""); }} maxLength={csvMode ? 200_000 : 50_000} spellCheck={!csvMode} className={`${field} mt-3 min-h-64 resize-y font-mono leading-6`} />
      <p className="mt-2 text-xs" style={{ color: `${c.deep}B8` }}>{text.length.toLocaleString()} characters{csvMode ? " / 200,000" : " / 50,000"}</p>
      {csvMode && <><label className="mt-4 block text-sm font-medium">Or open a CSV file<input type="file" accept=".csv,text/csv" className={`${field} mt-2`} onChange={(event) => importCsvFile(event.target.files?.[0])} /></label><p className="mt-3 text-xs leading-6" style={{ color: c.mutedFg }}>Preview and edit the table before export. Long cells are shortened in the PDF; wide tables split across pages. Non-Latin text may appear as question marks. The source stays on this device.</p></>}
      {csvMode ? <div className="mt-5 flex flex-wrap gap-2"><button type="button" data-utilities-dirty onClick={parseCsv} disabled={busy} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />Open table</button><button type="button" onClick={exportPdf} disabled={busy} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30` }}><Download className="size-4" />{loadingCsv ? "Loading CSV…" : busy ? "Making PDF…" : "Download PDF"}</button>{rows.length > 0 && <button type="button" onClick={exportCsv} disabled={busy} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30` }}>Download edited CSV</button>}</div> : markdown ? <div className="mt-5 flex flex-wrap gap-2"><button type="button" onClick={() => { download(text, "notes.md", "text/markdown;charset=utf-8"); track(slug, "download"); }} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white" style={{ background: c.deep }}><Download className="size-4" />Download Markdown</button><button type="button" onClick={() => { download(preview, "notes.html", "text/html;charset=utf-8"); track(slug, "download"); }} disabled={!preview} className="rounded-full border px-5 py-3 text-sm font-medium disabled:opacity-50" style={{ borderColor: `${c.deep}30` }}>Download safe HTML</button></div> : <div className="mt-5 flex flex-wrap gap-2">{(["upper", "lower", "trim", "sort"] as const).map((action) => <button key={action} type="button" data-utilities-dirty onClick={() => changeText(action)} className="rounded-full border px-4 py-2 text-sm capitalize" style={{ borderColor: `${c.deep}30` }}>{action}</button>)}<button type="button" data-utilities-dirty onClick={() => { version.current++; previewVersion.current++; invalidateTextResult(); setPreview(""); setText(initialText); setError(""); setNotice(""); }} className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm" style={{ borderColor: `${c.deep}30` }}><RotateCcw className="size-4" />Reset</button></div>}
      {error && <p role="alert" className="mt-5 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
      {notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}>
      {csvMode ? <><h2 className="font-semibold">Editable table preview</h2>{rows.length ? <><div className="mt-4 max-h-[30rem] max-w-full overflow-auto rounded-xl bg-white p-2"><table className="border-collapse text-sm text-slate-950"><tbody>{tableWindow.cells.map(({ rowIndex, cells }) => <tr key={rowIndex}>{cells.map(({ columnIndex, value }) => <td key={columnIndex} className="border border-slate-200 p-1"><input aria-label={`Row ${rowIndex + 1} column ${columnIndex + 1}`} value={value} disabled={loadingCsv} onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)} className="w-32 min-w-0 p-1 outline-none focus:ring-2" /></td>)}</tr>)}</tbody></table></div><div className="mt-4 space-y-3 text-xs"><p role="status">Rows {tableWindow.rowStart + 1}–{tableWindow.rowEnd} of {tableWindow.rowCount} · Columns {tableWindow.columnStart + 1}–{tableWindow.columnEnd} of {tableWindow.columnCount}. Downloads include the entire table.</p><nav aria-label="Table pagination" className="flex flex-wrap gap-2"><button type="button" disabled={tableWindow.rowPage === 0} onClick={() => setRowPage(tableWindow.rowPage - 1)} className="rounded-full border border-white/30 px-3 py-2 disabled:opacity-40">Previous rows</button><button type="button" disabled={tableWindow.rowPage + 1 >= tableWindow.rowPages} onClick={() => setRowPage(tableWindow.rowPage + 1)} className="rounded-full border border-white/30 px-3 py-2 disabled:opacity-40">Next rows</button><button type="button" disabled={tableWindow.columnPage === 0} onClick={() => setColumnPage(tableWindow.columnPage - 1)} className="rounded-full border border-white/30 px-3 py-2 disabled:opacity-40">Previous columns</button><button type="button" disabled={tableWindow.columnPage + 1 >= tableWindow.columnPages} onClick={() => setColumnPage(tableWindow.columnPage + 1)} className="rounded-full border border-white/30 px-3 py-2 disabled:opacity-40">Next columns</button></nav></div><div className="mt-4 flex flex-wrap gap-2"><button type="button" data-utilities-dirty disabled={loadingCsv} onClick={() => { version.current++; setBusy(false); setLoadingCsv(false); setNotice(""); setRows((current) => current.length < 1001 ? [...current, Array(current[0].length).fill("")] : current); }} className="inline-flex items-center gap-1 rounded-full border border-white/30 px-3 py-2 text-xs"><Plus className="size-3" />Row</button><button type="button" data-utilities-dirty disabled={loadingCsv} onClick={() => { version.current++; setBusy(false); setLoadingCsv(false); setNotice(""); setRows((current) => current[0].length < 100 ? current.map((row) => [...row, ""]) : current); }} className="inline-flex items-center gap-1 rounded-full border border-white/30 px-3 py-2 text-xs"><Plus className="size-3" />Column</button></div></> : <p className="mt-5 text-sm text-white/65">Open the CSV to edit cells. Exported CSV neutralizes spreadsheet formulas.</p>}</> : markdown ? <><h2 className="font-semibold">Live preview</h2><div className="prose prose-invert mt-4 max-h-[32rem] max-w-none overflow-auto break-words rounded-xl bg-white/10 p-5" dangerouslySetInnerHTML={{ __html: preview }} /></> : <><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Text workspace</h2>{completed && <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-full border border-white/30 px-3 py-2 text-xs">{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? "Copied" : "Copy result"}</button>}</div><p className="mt-4 text-sm text-white/70">{stats.words} words · {stats.characters} characters · {stats.lines} lines</p>{completed && <><pre className="mt-5 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-white/10 p-4 text-sm">{result || <span className="text-white/65">The result is empty.</span>}</pre><button type="button" onClick={() => { download(result, "text-result.txt", "text/plain;charset=utf-8"); track(slug, "download"); }} className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium" style={{ color: c.deep }}><Download className="size-4" />Download result</button></>}</>}
    </div>
  </div>;
}
