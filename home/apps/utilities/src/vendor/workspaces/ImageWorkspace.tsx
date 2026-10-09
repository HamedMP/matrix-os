import { reportToolFailure } from "../lib/diagnostics.mjs";

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Check, Copy, Download, ImageIcon, Play, RotateCcw, Upload } from "lucide-react";
import { palette as c } from "@matrix-os/brand";
import { toolEvent } from "../lib/telemetry.mjs";
import { capturePostHogEvent } from "../runtime/telemetry";

type Result = { blob?: Blob; filename?: string; width?: number; height?: number; text?: string; notice?: string; swatch?: string; tagScores?: { label: string; score: number }[] };
type Task = "convert" | "compress" | "resize" | "pdf";
const MANY = new Set(["images-to-pdf"]);

function track(slug: string, action: "start" | "success" | "error" | "copy" | "download", error?: unknown) {
  const event = toolEvent(slug, action, error);
  capturePostHogEvent(event.name, event.properties);
}

function taskFor(slug: string): Task {
  if (slug === "compress-image") return "compress";
  if (slug === "resize-image") return "resize";
  if (slug === "images-to-pdf") return "pdf";
  return "convert";
}

export function ImageWorkspace({ slug }: { slug: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [task, setTask] = useState<Task>(taskFor(slug));
  const [format, setFormat] = useState<"png" | "jpeg" | "webp">("webp");
  const [quality, setQuality] = useState(78);
  const [width, setWidth] = useState("1200");
  const [height, setHeight] = useState("1200");
  const [preserveRatio, setPreserveRatio] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [upscaleFactor, setUpscaleFactor] = useState<2 | 4>(2);
  const [upscaleMode, setUpscaleMode] = useState<"smooth" | "ai">("smooth");
  const [tagLabels, setTagLabels] = useState("person, product, animal, landscape, food, vehicle");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  const version = useRef(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const inputId = `image-file-${slug}`;
  const multiple = MANY.has(slug) || slug === "image-workspace" && task === "pdf";

  useEffect(() => {
    if (!files[0]) { setPreviewUrl(""); return; }
    const url = URL.createObjectURL(files[0]);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [files]);
  useEffect(() => {
    if (!result?.blob) { setResultUrl(""); return; }
    const url = URL.createObjectURL(result.blob);
    setResultUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);
  useEffect(() => () => { version.current++; operationRef.current?.abort(); operationRef.current = null; if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  function invalidate() {
    version.current++; operationRef.current?.abort(); operationRef.current = null;
    setBusy(false); setStage(""); setProgress(0); setResult(null); setResultUrl(""); setError(""); setCopied(false);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }
  function isCurrent(current: number, operation: AbortController) {
    return version.current === current && operationRef.current === operation && !operation.signal.aborted;
  }

  function selectFiles(next: File[]) {
    invalidate();
    if (next.length > (multiple ? 10 : 1)) { setFiles([]); setError(multiple ? "Choose up to 10 images." : "Choose one image."); return; }
    if (next.reduce((sum, file) => sum + file.size, 0) > 60 * 1024 * 1024) { setFiles([]); setError("Choose no more than 60 MB of images at once."); return; }
    if (next.some((file) => file.size > 20 * 1024 * 1024)) { setFiles([]); setError("Each image must be 20 MB or smaller."); return; }
    setFiles(next);
  }

  function reset() {
    invalidate();
    setFiles([]); setResult(null); setError(""); setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function run() {
    invalidate(); const current = version.current;
    const operation = new AbortController();
    operationRef.current = operation;
    const updateStage = (value: string) => { if (isCurrent(current, operation)) setStage(value); };
    const updateProgress = (value: number) => { if (isCurrent(current, operation)) setProgress(value); };
    setError(""); setResult(null); setBusy(true); setProgress(0); track(slug, "start");
    try {
      if (!files.length) throw new Error("Choose an image first.");
      const imageTools = await import("../lib/image-tools.mjs");
      if (!isCurrent(current, operation)) return;
      let next: Result;
      if (slug === "image-metadata") {
        const info = await imageTools.inspectImageFile(files[0]);
        next = { text: JSON.stringify(info, null, 2), notice: "Only basic file details and supported JPEG EXIF fields are shown. GPS data is never displayed." };
      } else if (slug === "image-ocr") {
        const text = await imageTools.recognizeImageText(files[0], updateProgress);
        next = { text: text.trim() || "No readable English text found.", notice: "Text recognition runs locally after the OCR model downloads to this browser. Check the result before use." };
      } else if (slug === "image-color-picker") {
        throw new Error("Click a point on the image preview to pick its color.");
      } else if (slug === "image-upscale") {
        if (upscaleMode === "ai") {
          const { upscaleImageLocally } = await import("../lib/image-super-resolution.mjs");
          if (!isCurrent(current, operation)) return;
          const output = await upscaleImageLocally(files[0], updateStage, operation.signal);
          next = { blob: output.blob, filename: output.filename, width: output.width, height: output.height, notice: "Enhanced 2× with a model in this browser. It predicts plausible detail; review the result because it cannot recover the exact original detail." };
        } else {
          const output = await imageTools.upscaleImage(files[0], upscaleFactor);
          next = { blob: output.blob, filename: output.filename, width: output.width, height: output.height, notice: "Enlarged with browser interpolation. This increases pixel dimensions but cannot recover missing detail." };
        }
      } else if (slug === "blur-faces") {
        const output = await imageTools.blurFaces(files[0], updateStage, operation.signal);
        next = output.blob ? { blob: output.blob, filename: output.filename, width: output.width, height: output.height, notice: `${output.count} face${output.count === 1 ? "" : "s"} detected and pixelated. Review the result: small, angled, or obscured faces may be missed.` } : { notice: "No faces detected. No image was changed. Try a clearer or larger photo." };
      } else if (slug === "remove-background") {
        const output = await imageTools.removePortraitBackground(files[0], updateStage, operation.signal);
        next = { blob: output.blob, filename: output.filename, width: output.width, height: output.height, notice: "Transparent PNG. The model works best on a single human portrait; hair edges and non-person subjects may need manual cleanup. Output is at most 1,024 px per side." };
      } else if (slug === "zero-shot-image-tags") {
        const scores = await imageTools.classifyImageLabels(files[0], tagLabels, updateStage, operation.signal);
        next = { tagScores: scores, text: scores.map(({ label, score }: { label: string; score: number }) => `${label}: ${score}% relative match`).join("\n"), notice: "Scores compare only the labels you entered. They are not independent probabilities or a guarantee that any label is correct." };
      } else if (slug === "image-caption-generator") {
        const { captionImageLocally } = await import("../lib/image-caption.mjs");
        if (!isCurrent(current, operation)) return;
        const caption = await captionImageLocally(files[0], updateStage, operation.signal);
        next = { text: caption, notice: "Generated by a local image model. Captions can miss details or invent objects; review before publishing." };
      } else if (task === "pdf") {
        const output = await imageTools.imagesToPdf(files);
        next = { blob: new Blob([new Uint8Array(output.bytes)], { type: output.mime }), filename: output.filename, notice: `${files.length} image${files.length === 1 ? "" : "s"} placed on separate PDF pages.` };
      } else {
        const output = await imageTools.renderImage(files[0], {
          ...(task === "resize" ? { width: Number(width), height: Number(height), stretch: !preserveRatio } : {}),
          format: task === "compress" && format === "png" ? "webp" : format,
          quality: quality / 100,
        });
        next = { blob: output.blob, filename: output.filename, width: output.width, height: output.height,
          notice: task === "compress" ? `${(files[0].size / 1024).toFixed(0)} KB → ${(output.blob.size / 1024).toFixed(0)} KB. The output may be larger for some source images.` : undefined };
      }
      if (isCurrent(current, operation)) { setResult(next); track(slug, "success"); }
    } catch (cause) {
      if (isCurrent(current, operation)) { setError(cause instanceof Error ? cause.message : "Could not process this image."); track(slug, "error", cause); }
    } finally { if (isCurrent(current, operation)) { operationRef.current = null; setBusy(false); setStage(""); } }
  }

  async function pickColor(clientX: number, clientY: number) {
    if (slug !== "image-color-picker" || !files[0]) return;
    const element = imageRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const naturalWidth = element.naturalWidth, naturalHeight = element.naturalHeight;
    if (!naturalWidth || !naturalHeight) return;
    invalidate(); const current = version.current;
    const operation = new AbortController(); operationRef.current = operation;
    setBusy(true); track(slug, "start");
    try {
      const imageTools = await import("../lib/image-tools.mjs");
      if (!isCurrent(current, operation)) return;
      await imageTools.checkedImageBytes(files[0]);
      if (!isCurrent(current, operation)) return;
      imageTools.validateImageDimensions(naturalWidth, naturalHeight);
      // A one-pixel canvas avoids allocating another full decoded image.
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser could not read the image color.");
      const { x, y } = imageTools.imagePointFromClick(rect, naturalWidth, naturalHeight, clientX, clientY);
      context.drawImage(element, -x, -y);
      const sample = imageTools.readPixelColor(context.getImageData(0, 0, 1, 1), 0, 0);
      setResult({ text: `${sample.hex}\n${sample.rgba}`, swatch: sample.hex, notice: `Pixel ${x + 1}, ${y + 1} of ${naturalWidth} × ${naturalHeight}` });
      track(slug, "success");
    } catch (cause) { if (!isCurrent(current, operation)) return; setError(cause instanceof Error ? cause.message : "Could not pick a color."); track(slug, "error", cause); }
    finally { if (isCurrent(current, operation)) { operationRef.current = null; setBusy(false); } }
  }

  async function copy() {
    if (!result?.text) return;
    const current = version.current;
    try { await navigator.clipboard.writeText(result.text); if (version.current !== current) return; setCopied(true); track(slug, "copy"); copyTimer.current = setTimeout(() => setCopied(false), 2000); }
    catch (cause) { reportToolFailure(cause); if (version.current === current) setError("Could not copy automatically. Select the result text to copy it."); }
  }

  function download() {
    if (!resultUrl || !result?.filename) return;
    const link = document.createElement("a"); link.href = resultUrl; link.download = result.filename; link.click();
    track(slug, "download");
  }

  function downloadText() {
    if (!result?.text) return;
    const blob = new Blob([result.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `${slug}.txt`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    track(slug, "download");
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) { const next = Array.from(event.target.files ?? []); if (next.length) selectFiles(next); }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); selectFiles(Array.from(event.dataTransfer.files)); }

  return <div onChangeCapture={(event) => { if ((event.target as HTMLInputElement).type !== "file") invalidate(); }} className="grid min-w-0 gap-5 lg:grid-cols-2">
    <div className="min-w-0 rounded-3xl border bg-white p-5 sm:p-7" style={{ borderColor: `${c.deep}25` }}>
      {slug === "image-workspace" && <fieldset className="mb-6"><legend className="mb-3 text-sm font-semibold">What would you like to do?</legend><div className="flex flex-wrap gap-2">{(["convert", "compress", "resize", "pdf"] as Task[]).map((choice) => <button key={choice} type="button" data-utilities-dirty onClick={() => { setTask(choice); setFormat("webp"); reset(); }} aria-pressed={task === choice} className="rounded-full border px-4 py-2 text-sm capitalize" style={{ background: task === choice ? c.deep : "white", color: task === choice ? "white" : c.deep, borderColor: `${c.deep}35` }}>{choice === "pdf" ? "Make PDF" : choice}</button>)}</div></fieldset>}
      <div onDragOver={(event) => event.preventDefault()} onDrop={onDrop} className="rounded-2xl border border-dashed p-5 sm:p-7" style={{ borderColor: `${c.deep}40`, background: c.pageBg }}>
        <label htmlFor={inputId} className="flex cursor-pointer flex-col items-center gap-2 text-center"><Upload className="size-7" aria-hidden="true" /><span className="font-semibold">Choose {multiple ? "images" : "an image"} or drop {multiple ? "them" : "it"} here</span><span className="text-xs opacity-70">PNG, JPEG, or WebP · 20 MB per file{multiple ? " · up to 10 images" : ""}</span></label>
        <input ref={inputRef} id={inputId} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple={multiple} onChange={onInput} className="mt-4 block w-full min-w-0 text-xs file:mr-3 file:rounded-full file:border-0 file:px-3 file:py-2" />
      </div>
      {files.length > 0 && <><ul aria-label="Selected images" className="mt-4 space-y-1 text-sm">{files.map((file, index) => <li key={`${file.name}-${index}`} className="min-w-0 truncate">{index + 1}. {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</li>)}</ul>{previewUrl && (slug === "image-color-picker" ? <button type="button" data-utilities-dirty aria-label="Pick a color from the image; press Enter to sample its center" onClick={(event) => { const rect = imageRef.current?.getBoundingClientRect(); const x = event.detail === 0 && rect ? rect.left + rect.width / 2 : event.clientX; const y = event.detail === 0 && rect ? rect.top + rect.height / 2 : event.clientY; void pickColor(x, y); }} className="mt-5 block w-full cursor-crosshair rounded-xl border focus:outline-2 focus:outline-offset-2" style={{ borderColor: `${c.deep}40` }}><img ref={imageRef} src={previewUrl} alt="Preview of selected image" className="max-h-80 w-full rounded-xl object-contain" /></button> : <img src={previewUrl} alt="Preview of selected image" className="mt-5 max-h-80 w-full rounded-xl border object-contain" />)}</>}
      {slug === "image-color-picker" && <p className="mt-4 text-sm opacity-75">Click the image to inspect the exact pixel color.</p>}
      {(task === "convert" || task === "compress" || task === "resize") && !["image-metadata", "image-ocr", "image-color-picker", "image-upscale", "blur-faces", "remove-background", "zero-shot-image-tags", "image-caption-generator"].includes(slug) && <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Output format<select value={format} onChange={(event) => { setFormat(event.target.value as "png" | "jpeg" | "webp"); setResult(null); }} className="mt-2 w-full rounded-xl border p-3"><option value="webp">WebP</option>{task !== "compress" && <option value="png">PNG</option>}<option value="jpeg">JPEG</option></select></label>{format !== "png" && <label className="text-sm font-medium">Quality: {quality}%<input type="range" min="10" max="100" value={quality} onChange={(event) => { setQuality(Number(event.target.value)); setResult(null); }} className="mt-4 w-full" /></label>}</div>}
      {task === "resize" && <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Maximum width (px)<input type="number" min="1" max="8192" value={width} onChange={(event) => { setWidth(event.target.value); setResult(null); }} className="mt-2 w-full rounded-xl border p-3" /></label><label className="text-sm font-medium">Maximum height (px)<input type="number" min="1" max="8192" value={height} onChange={(event) => { setHeight(event.target.value); setResult(null); }} className="mt-2 w-full rounded-xl border p-3" /></label><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={preserveRatio} onChange={(event) => { setPreserveRatio(event.target.checked); setResult(null); }} /> Keep original proportions</label></div>}
      {slug === "image-ocr" && <p className="mt-4 text-sm opacity-75">The first run downloads an English OCR model to this browser. Your image stays here and is not uploaded for recognition.</p>}
      {slug === "image-upscale" && <div className="mt-5 space-y-4"><fieldset><legend className="mb-2 text-sm font-semibold">How would you like to enlarge it?</legend><div className="grid gap-2 sm:grid-cols-2">{(["smooth", "ai"] as const).map((mode) => <label key={mode} className="flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm" style={{ borderColor: upscaleMode === mode ? c.deep : `${c.deep}30`, background: upscaleMode === mode ? `${c.deep}0d` : "white" }}><input type="radio" name="upscale-mode" value={mode} checked={upscaleMode === mode} onChange={() => { setUpscaleMode(mode); setResult(null); setError(""); }} className="mt-0.5" /><span><strong className="block">{mode === "smooth" ? "Smooth enlargement" : "AI detail enhancement"}</strong><span className="mt-1 block opacity-70">{mode === "smooth" ? "2× or 4× · fast · WebP" : "2× · local model · PNG"}</span></span></label>)}</div></fieldset>{upscaleMode === "smooth" ? <><label className="block text-sm font-medium">Enlarge by<select value={upscaleFactor} onChange={(event) => { setUpscaleFactor(Number(event.target.value) as 2 | 4); setResult(null); }} className="mt-2 w-full rounded-xl border p-3"><option value={2}>2×</option><option value={4}>4×</option></select></label><p className="text-sm opacity-75">Browser interpolation smooths enlarged pixels but cannot add real detail.</p></> : <p className="text-sm leading-6 opacity-75">For small images up to 256 pixels per side and 32,768 pixels total. The first run downloads about 7 MB of model files plus a browser runtime. Your image stays in this browser. The model predicts detail and may get it wrong; larger images need more memory, so use smooth enlargement for those.</p>}</div>}
      {slug === "blur-faces" && <p className="mt-4 text-sm opacity-75">The first run downloads Google’s MediaPipe face detector and its browser runtime. Detection runs here, then detected faces are pixelated. Your photo is never uploaded. Please review the result for missed faces.</p>}
      {slug === "remove-background" && <p className="mt-4 text-sm opacity-75">Runs a local portrait model in a browser worker. The first run downloads about 7 MB of model data plus a browser runtime. Your image stays in this browser. Best for one human portrait; output is a transparent PNG up to 1,024 px per side.</p>}
      {slug === "zero-shot-image-tags" && <div className="mt-5"><label htmlFor="image-tag-labels" className="text-sm font-medium">Labels to compare</label><textarea id="image-tag-labels" value={tagLabels} onChange={(event) => { setTagLabels(event.target.value); setResult(null); }} rows={3} maxLength={500} spellCheck={false} className="mt-2 w-full rounded-xl border p-3 text-sm" placeholder="person, product, animal, landscape" /><p className="mt-2 text-sm opacity-75">Enter 2 to 12 unique labels separated by commas. TinyCLIP (MIT) compares only those labels. The first run downloads about 30 MB of model and tokenizer files plus a browser runtime. Your image stays in this browser; check the suggested tags before using them.</p></div>}
      {slug === "image-caption-generator" && <p className="mt-4 text-sm opacity-75">The first run downloads about 250 MB of Apache-2.0 model files plus a browser runtime. Captioning runs in this browser; your image is not uploaded. It can take a few minutes on a phone or older computer. Review the caption for mistakes.</p>}
      <div className="mt-6 flex flex-wrap gap-2">{slug !== "image-color-picker" && <button type="button" data-utilities-dirty onClick={run} disabled={busy || !files.length} className="inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white disabled:opacity-50" style={{ background: c.deep }}><Play className="size-4" />{busy ? slug === "image-ocr" ? `Reading… ${progress}%` : stage || "Working…" : task === "pdf" ? "Create PDF" : slug === "image-ocr" ? "Read image text" : slug === "image-metadata" ? "Inspect image" : slug === "image-upscale" ? upscaleMode === "ai" ? "Enhance image 2×" : "Enlarge image" : slug === "blur-faces" ? "Detect and blur faces" : slug === "remove-background" ? "Remove background" : slug === "zero-shot-image-tags" ? "Compare labels" : slug === "image-caption-generator" ? "Generate caption" : "Process image"}</button>}{busy && ["blur-faces", "remove-background", "zero-shot-image-tags", "image-caption-generator"].includes(slug) || busy && slug === "image-upscale" && upscaleMode === "ai" ? <button type="button" onClick={invalidate} className="rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}>Cancel</button> : null}<button type="button" data-utilities-dirty={files.length || result || busy ? true : undefined} onClick={reset} className="inline-flex items-center gap-2 rounded-full border px-5 py-3 text-sm font-medium" style={{ borderColor: `${c.deep}30` }}><RotateCcw className="size-4" />Clear</button></div>
    </div>
    <div className="min-w-0 rounded-3xl border p-5 text-white sm:p-7" style={{ background: c.deep, borderColor: c.deep }}><h2 className="text-base font-semibold">Result</h2>{error ? <p role="alert" className="mt-5 rounded-xl bg-red-100 p-4 text-sm text-red-950">{error}</p> : result ? <div className="mt-6 space-y-5"><ImageIcon className="size-9" aria-hidden="true" />{result.width && <p>{result.width.toLocaleString()} × {result.height?.toLocaleString()} pixels</p>}{result.notice && <p className="break-words text-sm text-white/75">{result.notice}</p>}{result.swatch && <div className="h-16 w-full rounded-xl border border-white/25" style={{ backgroundColor: result.swatch }} aria-label={`Selected color ${result.swatch}`} />}{result.tagScores && <ol aria-label="Relative image label matches" className="space-y-3" aria-live="polite">{result.tagScores.map(({ label, score }) => <li key={label}><div className="mb-1 flex justify-between gap-3 text-sm"><span className="min-w-0 break-words">{label}</span><span>{score}%</span></div><div className="h-2 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-white" style={{ width: `${score}%` }} /></div></li>)}</ol>}{result.text && !result.tagScores && (slug === "image-caption-generator" ? <blockquote className="rounded-2xl border border-white/20 bg-white/10 p-5 text-lg leading-8 sm:text-xl" aria-live="polite">{result.text}</blockquote> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-2xl bg-black/20 p-4 text-sm leading-6" aria-live="polite">{result.text}</pre>)}{resultUrl && result?.blob?.type.startsWith("image/") && <img src={resultUrl} alt="Processed image preview" className="max-h-64 w-full rounded-xl object-contain" />}{resultUrl ? <button type="button" onClick={download} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}><Download className="size-4" />Download {result.blob?.type === "application/pdf" ? "PDF" : "image"}</button> : result.text && <div className="flex flex-wrap gap-2"><button type="button" onClick={copy} className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold" style={{ color: c.deep }}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : slug === "image-caption-generator" ? "Copy caption" : "Copy result"}</button><button type="button" onClick={downloadText} className="inline-flex items-center gap-2 rounded-full border border-white/30 px-5 py-3 text-sm font-semibold"><Download className="size-4" />Download text</button></div>}</div> : <div className="mt-5 flex min-h-72 items-center justify-center rounded-2xl border border-dashed border-white/25 p-6 text-center text-sm text-white/60">Your result will appear here. Files stay in this browser tab.</div>}</div>
  </div>;
}
