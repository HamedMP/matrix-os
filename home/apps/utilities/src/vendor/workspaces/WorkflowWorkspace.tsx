import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Play, Plus, Trash2 } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { tools } from "../lib/catalog.mjs";
import { runWorkflow, validateWorkflow } from "../lib/workflow-tools.mjs";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

const stepsAvailable = tools.filter((tool) => tool.mode === "text");
const start = "  Free browser tools from Matrix OS  ";

function track(action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent("workflows", action, error);
  capturePostHogEvent(event.name, event.properties);
}

function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkflowWorkspace() {
  const [input, setInput] = useState(start);
  const [steps, setSteps] = useState(["text-cleaner", "slug-generator"]);
  const [output, setOutput] = useState("");
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const version = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { version.current++; if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  function invalidate() { version.current++; setBusy(false); setOutput(""); setCompleted(false); setError(""); setCopied(false); if (copyTimer.current) clearTimeout(copyTimer.current); }
  const selected = useMemo(() => steps.map((slug) => tools.find((tool) => tool.slug === slug)?.title ?? slug), [steps]);

  async function run() {
    const current = ++version.current;
    setError(""); setOutput(""); setCompleted(false); setBusy(true); track("start");
    try { const result = await runWorkflow(input, steps); if (version.current !== current) return; setOutput(result.output); setCompleted(true); track("success"); }
    catch (cause) { if (version.current !== current) return; setError(cause instanceof Error ? cause.message : "Workflow could not finish."); track("error", cause); }
    finally { if (version.current === current) setBusy(false); }
  }

  async function importDefinition(file: File | undefined) {
    if (!file) return;
    invalidate(); const current = version.current;
    setError(""); track("start");
    try {
      if (file.size > 10_000) throw new Error("Workflow file must be 10 KB or smaller.");
      const text = await file.text();
      if (version.current !== current) return;
      const value = JSON.parse(text);
      const slugs = validateWorkflow(value?.steps);
      setSteps([...slugs]); setOutput(""); track("success");
    } catch (cause) { if (version.current !== current) return; setError(cause instanceof Error ? cause.message : "Choose a valid workflow JSON file."); track("error", cause); }
  }

  async function copyOutput() {
    const current = version.current;
    try { await navigator.clipboard.writeText(output); if (version.current !== current) return; setCopied(true); track("copy"); copyTimer.current = setTimeout(() => setCopied(false), 1500); }
    catch (cause) { if (version.current === current) { reportToolFailure(cause); setError("Could not copy automatically."); } }
  }

  const resultContent = completed ? <>
    {output ? <pre className="mt-5 max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-xl bg-white/10 p-4 text-sm">{output}</pre> : <p className="mt-5 rounded-xl bg-white/10 p-4 text-sm text-white/70">The result is empty.</p>}
    <div className="mt-5 flex flex-wrap gap-2">
      <button type="button" onClick={copyOutput} className="inline-flex items-center gap-1 rounded-full border border-white/30 px-4 py-2 text-xs">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy"}</button>
      <button type="button" onClick={() => { download(output, "workflow-result.txt", "text/plain;charset=utf-8"); track("download"); }} className="inline-flex items-center gap-1 rounded-full border border-white/30 px-4 py-2 text-xs"><Download className="size-4" />Download</button>
    </div>
  </> : <div className="mt-5 flex min-h-64 items-center justify-center rounded-xl border border-dashed border-white/25 p-5 text-center text-sm text-white/60">Run the steps to see the final output here.</div>;

  return <div onChangeCapture={invalidate} className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}><h2 className="text-lg font-semibold">Build a local text workflow</h2><p className="mt-2 text-sm leading-6" style={{ color: `${c.deep}B8` }}>Each step uses a working Matrix text tool. The next step receives the previous result. The flow runs only while this tab is open.</p>
      <label htmlFor="workflow-input" className="mt-5 block text-sm font-semibold">Starting text</label><textarea id="workflow-input" value={input} onChange={(event) => setInput(event.target.value)} maxLength={100_000} spellCheck={false} className="mt-2 min-h-36 w-full min-w-0 resize-y rounded-xl border p-3 text-sm" style={{ borderColor: `${c.deep}25` }} />
      <h3 className="mt-6 text-sm font-semibold">Steps ({steps.length}/10)</h3><ol className="mt-3 space-y-3">{steps.map((slug, index) => <li key={index} className="flex min-w-0 items-center gap-2"><span className="w-6 shrink-0 text-sm">{index + 1}.</span><select aria-label={`Step ${index + 1}`} value={slug} onChange={(event) => setSteps((current) => current.map((item, i) => i === index ? event.target.value : item))} className="min-w-0 flex-1 rounded-xl border bg-white p-3 text-sm" style={{ borderColor: `${c.deep}25` }}>{stepsAvailable.map((tool) => <option key={tool.slug} value={tool.slug}>{tool.title}</option>)}</select><button type="button" data-utilities-dirty onClick={() => { invalidate(); setSteps((current) => current.filter((_, i) => i !== index)); }} disabled={steps.length === 1} aria-label={`Remove step ${index + 1}`} className="rounded-xl border p-3 disabled:opacity-40" style={{ borderColor: `${c.deep}25` }}><Trash2 className="size-4" /></button></li>)}</ol>
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" data-utilities-dirty onClick={() => { invalidate(); setSteps((current) => current.length < 10 ? [...current, "text-cleaner"] : current); }} disabled={steps.length >= 10} className="inline-flex items-center gap-1 rounded-full border px-4 py-2 text-sm disabled:opacity-40" style={{ borderColor: `${c.deep}30` }}><Plus className="size-4" />Add step</button><button type="button" onClick={() => { download(JSON.stringify({ version: 1, steps }, null, 2), "matrix-workflow.json", "application/json"); track("download"); }} className="inline-flex items-center gap-1 rounded-full border px-4 py-2 text-sm" style={{ borderColor: `${c.deep}30` }}><Download className="size-4" />Save steps</button></div>
      <label className="mt-4 block text-sm">Load saved steps<input type="file" accept=".json,application/json" onChange={(event) => { void importDefinition(event.target.files?.[0]); }} className="mt-2 block w-full rounded-xl border p-3 text-xs" style={{ borderColor: `${c.deep}25` }} /></label>
      <button type="button" data-utilities-dirty onClick={run} disabled={busy || !input.trim()} className="mt-6 inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{busy ? "Running…" : "Run workflow"}</button><button type="button" data-utilities-dirty onClick={() => { invalidate(); setInput(""); }} className="ml-2 rounded-full border px-4 py-3 text-sm" style={{ borderColor: `${c.deep}30` }}>Clear</button>{error && <p role="alert" className="mt-4 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p>}
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-lg font-semibold">Result</h2><p className="mt-2 text-xs text-white/65">{selected.join(" → ")}</p>{resultContent}</div>
  </div>;
}
