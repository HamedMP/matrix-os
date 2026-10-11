import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Play, RotateCcw } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { runTool } from "../lib/engine.mjs";
import { countText, jsonCsvTable } from "../lib/workspace-tools.mjs";
import { createCounterSession, toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

const downloadTypes: Record<string, [string, string]> = {
  "json-to-csv": ["csv", "text/csv"], "csv-to-json": ["json", "application/json"],
  "sitemap-xml-generator": ["xml", "application/xml"], "robots-txt-generator": ["txt", "text/plain"],
  "schema-jsonld-generator": ["json", "application/ld+json"], "markdown-preview": ["html", "text/html"],
};
const field = "w-full min-w-0 rounded-xl border bg-white p-3 text-sm outline-none focus:ring-2";

export function ToolWorkspace({ slug, example }: { slug: string; example: string }) {
  const counter = slug === "word-counter" || slug === "character-counter";
  const findReplace = slug === "find-replace";
  const csv = slug === "json-to-csv";
  const exampleParts = example.split("\n");
  const initialInput = findReplace ? exampleParts.slice(2).join("\n") : example;
  const [input, setInput] = useState(initialInput);
  const [output, setOutput] = useState("");
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(findReplace ? exampleParts[0] : "");
  const [replacement, setReplacement] = useState(findReplace ? exampleParts[1] : "");
  const [delimiter, setDelimiter] = useState(",");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [table, setTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [hashFormat, setHashFormat] = useState<"hex" | "base64" | "sri">("hex");
  const version = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { version.current++; if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const recordCounterSession = useMemo(() => createCounterSession(slug, (event: { name: string; properties: Record<string, string> }) => capturePostHogEvent(event.name, event.properties)), [slug]);
  const stats = useMemo(() => counter ? countText(input) : null, [counter, input]);
  const result = stats ? slug === "word-counter" ? `Words: ${stats.words}\nCharacters: ${stats.characters}\nSentences: ${stats.sentences}\nEstimated reading time: ${stats.readingMinutes} min` : `Characters: ${stats.characters}\nWithout whitespace: ${stats.withoutWhitespace}\nLines: ${stats.lines}\nUTF-8 bytes: ${stats.bytes}` : output;

  function invalidate() { setCompleted(false); version.current++; setBusy(false); setError(""); setOutput(""); setTable(null); setCopied(false); }
  async function run() {
    const current = ++version.current;
    setBusy(true); setCompleted(false); setCopied(false); setError(""); setOutput(""); setTable(null);
    track(slug, "start");
    try {
      const options = findReplace ? { search, replacement } : csv ? { delimiter, includeHeader } : slug === "hash-generator" ? { hashFormat } : {};
      const value = await runTool(slug, input, options);
      if (version.current !== current) return;
      setOutput(value.output);
      if (csv) setTable(jsonCsvTable(input));
      setCompleted(true);
      track(slug, "success");
    } catch (cause) {
      if (version.current !== current) return;
      setError(cause instanceof Error ? cause.message : "Could not process this input."); track(slug, "error", cause);
    } finally { if (version.current === current) setBusy(false); }
  }
  async function copy() {
    recordCounterSession();
    const current = version.current;
    try {
      await navigator.clipboard.writeText(result);
      if (version.current !== current) return;
      setCopied(true); track(slug, "copy");
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch (cause) { reportToolFailure(cause); if (version.current === current) setError("Could not copy automatically. Select and copy the result instead."); }
  }
  function download() {
    recordCounterSession();
    const [extension, type] = downloadTypes[slug] ?? ["txt", "text/plain"];
    const url = URL.createObjectURL(new Blob([result], { type: `${type};charset=utf-8` }));
    const link = document.createElement("a"); link.href = url; link.download = `${slug}.${extension}`; document.body.append(link); link.click(); link.remove();
    track(slug, "download");
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reset() {
    invalidate(); setInput(initialInput); setHashFormat("hex"); setSearch(exampleParts[0]); setReplacement(exampleParts[1] ?? ""); setDelimiter(","); setIncludeHeader(true);
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><label htmlFor="tool-input" className="text-base font-semibold" style={{ color: c.deep }}>{csv ? "JSON array" : counter || findReplace ? "Your text" : "Your input"}</label><span className="text-xs" style={{ color: `${c.deep}99` }}>{input.length.toLocaleString()} / 100,000</span></div>
      <textarea id="tool-input" value={input} onChange={(event) => { recordCounterSession(); invalidate(); setInput(event.target.value); }} maxLength={100_000} spellCheck={counter || findReplace} placeholder={counter ? "Paste or type your text. Counts update as you write." : undefined} className="min-h-72 w-full min-w-0 resize-y rounded-2xl border p-4 text-sm leading-6 outline-none focus:ring-2" style={{ borderColor: `${c.deep}25`, color: c.deep, fontFamily: "var(--font-geist-mono), monospace" }} />
      {counter && <p className="mt-3 text-sm" style={{ color: c.mutedFg }}>Counts update instantly. Your text stays on this device.</p>}
      {findReplace && <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2"><label htmlFor="find-search" className="min-w-0 text-sm font-medium">Find<textarea id="find-search" value={search} maxLength={100_000} onChange={(event) => { invalidate(); setSearch(event.target.value); }} className={`${field} mt-2 min-h-20`} style={{ borderColor: `${c.deep}25` }} /></label><label htmlFor="find-replacement" className="min-w-0 text-sm font-medium">Replace with<textarea id="find-replacement" value={replacement} maxLength={100_000} onChange={(event) => { invalidate(); setReplacement(event.target.value); }} className={`${field} mt-2 min-h-20`} style={{ borderColor: `${c.deep}25` }} placeholder="Leave blank to delete matches" /></label><p className="text-xs sm:col-span-2" style={{ color: c.mutedFg }}>Matches are case-sensitive. Special characters and replacement text are treated literally.</p></div>}
      {csv && <div className="mt-4 space-y-3"><label className="block text-sm font-medium">CSV delimiter<select value={delimiter} onChange={(event) => { invalidate(); setDelimiter(event.target.value); }} className={`${field} mt-2`} style={{ borderColor: `${c.deep}25` }}><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value={"\t"}>Tab</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeHeader} onChange={(event) => { invalidate(); setIncludeHeader(event.target.checked); }} />Include column headers</label><p className="text-xs leading-5" style={{ color: c.mutedFg }}>Columns include keys from every object. Missing values become empty cells. Spreadsheet formulas are neutralized in the exported CSV.</p></div>}
      {slug === "hash-generator" && <label className="mt-3 block text-sm font-medium" style={{ color: c.deep }}>Output format<select value={hashFormat} onChange={(event) => { invalidate(); setHashFormat(event.target.value as "hex" | "base64" | "sri"); }} className={`${field} mt-2`} style={{ borderColor: `${c.deep}25` }}><option value="hex">Hexadecimal</option><option value="base64">Base64</option><option value="sri">Subresource integrity (SRI)</option></select></label>}
      {slug === "html-seo-audit" && <label className="mt-3 block text-sm font-medium">Or choose an HTML file<input type="file" accept=".html,.htm,text/html" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; invalidate(); const current = version.current; if (file.size > 100_000) { setError("HTML file must be 100 KB or smaller."); return; } try { const text = await file.text(); if (version.current === current) setInput(text); } catch (cause) { reportToolFailure(cause); if (version.current === current) setError("Could not open this HTML file."); } }} className={`${field} mt-2`} style={{ borderColor: `${c.deep}25` }} /></label>}
      <div className="mt-4 flex flex-wrap gap-2">{!counter && <button data-utilities-dirty="true" type="button" onClick={run} disabled={busy || !input.trim() || (findReplace && !search)} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{busy ? "Working…" : csv ? "Convert to CSV" : findReplace ? "Replace all" : "Run tool"}</button>}<button data-utilities-dirty="true" type="button" onClick={reset} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30`, color: c.deep }}><RotateCcw className="size-4" />Reset example</button><button data-utilities-dirty="true" type="button" onClick={() => { recordCounterSession(); invalidate(); setInput(""); }} className="rounded-full border px-5 py-3 text-sm" style={{ borderColor: `${c.deep}30`, color: c.deep }}>Clear</button></div>
    </div>
    <div className="min-w-0 rounded-3xl border p-5 sm:p-7" style={{ background: c.deep, borderColor: c.deep, color: "white" }}>
      <div className="mb-4 flex min-h-6 flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{counter ? "Live counts" : "Result"}</h2>{(counter || completed) && <div className="flex flex-wrap gap-2"><button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs hover:bg-white/10">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy"}</button><button type="button" onClick={download} className="inline-flex items-center gap-1 rounded-full border border-white/25 px-3 py-1.5 text-xs hover:bg-white/10"><Download className="size-3.5" />Download</button></div>}</div>
      {error ? <p role="alert" className="rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p> : stats ? <><dl className="grid grid-cols-2 gap-3" aria-live="polite" aria-atomic="true">{(slug === "word-counter" ? [["Words", stats.words], ["Characters", stats.characters], ["Sentences", stats.sentences], ["Reading time (min)", stats.readingMinutes]] : [["Characters", stats.characters], ["Without whitespace", stats.withoutWhitespace], ["Lines", stats.lines], ["UTF-8 bytes", stats.bytes]]).map(([label, value]) => <div key={label} className="min-w-0 rounded-2xl bg-white/10 p-4"><dt className="text-xs text-white/70">{label}</dt><dd className="mt-2 break-words text-3xl font-semibold tabular-nums">{Number(value).toLocaleString()}</dd></div>)}</dl><p className="mt-5 text-xs leading-6 text-white/70">Characters count Unicode code points, including spaces. Word boundaries and reading time are estimates; languages without spaces may need a language-specific counter.</p></> : completed ? <><pre className="max-h-[34rem] min-h-64 overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-black/20 p-4 text-sm leading-6" aria-live="polite">{output || "The result is empty. You can still copy or download it."}</pre>{table && <div className="mt-5"><h3 className="text-sm font-semibold">Table preview · {table.rows.length} rows · {table.headers.length} columns</h3><div className="mt-3 max-w-full overflow-auto rounded-xl bg-white/10"><table className="w-full text-left text-xs"><thead><tr>{table.headers.map((header, index) => <th key={index} className="max-w-60 border-b border-white/20 p-3 break-words">{header}</th>)}</tr></thead><tbody>{table.rows.slice(0, 10).map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} className="max-w-60 border-b border-white/10 p-3 break-words">{cell.slice(0, 160)}{cell.length > 160 ? "…" : ""}</td>)}</tr>)}</tbody></table></div><p className="mt-2 text-xs text-white/60">Preview shows original values for the first 10 rows. Download includes all rows and spreadsheet formula protection.</p></div>}</> : <div className="flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">Your result will appear here. The input stays in this browser tab.</div>}
    </div>
  </div>;
}
