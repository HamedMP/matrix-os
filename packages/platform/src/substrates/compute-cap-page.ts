import { desktopFonts, desktopPalette, palette } from '@matrix-os/brand/tokens';

/**
 * The platform's answer to a browser navigation at the monthly compute cap
 * (spec 2691). The runtime is not running, so the page is self-contained: no
 * customer-runtime assets, inline styles and script under a per-response
 * nonce. Copy mirrors the `compute` case of the shared limit screens
 * (`packages/ui/src/runtime-lifecycle/runtime-limit-copy.ts`, non-store
 * build) and the owner export failure copy (`runtime-export.ts`).
 */

export const COMPUTE_CAP_TITLE = "This month's computer time is used up";
/** The existing plans entry point the platform journey sends owners to. */
export const PLANS_PATH = '/?plans=1';
const PREPARING_COPY = 'Preparing your export';
const FAILURE_COPY = {
  in_progress: 'An export is already running. Try again when it finishes.',
  too_large: 'Your data is too large to export in one file. Contact support.',
  unavailable: 'Export is unavailable right now. Try again in a moment.',
  failed: 'Your data could not be exported. Try again.',
} as const;
/** The export-only wake answers 503 with Retry-After; the page retries this many times at most. */
const MAX_EXPORT_RETRIES = 10;
const MAX_RETRY_DELAY_SECONDS = 30;
/** The gateway bounds the export stream at ten minutes; the page waits a little longer, never forever. */
const EXPORT_TIMEOUT_MS = 11 * 60_000;

export interface ComputeCapPageInput {
  resetsAt: string;
  /** Same-origin export path for this handle; null hides the export button (not the owner). */
  exportPath: string | null;
  nonce: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** A JSON literal that cannot close the surrounding script element. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function serverDate(at: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(at);
}

export function computeCapPageCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

function styles(): string {
  return `*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:16px;background:${desktopPalette.canvas};color:${palette.brandInk};font:16px/1.55 ${desktopFonts.sans};-webkit-font-smoothing:antialiased}main{width:min(100%,520px);padding:40px clamp(20px,6vw,44px);border:1px solid ${palette.border};border-radius:24px;background:${desktopPalette.paper}}h1{margin:0;font:600 clamp(26px,4vw,34px)/1.12 ${desktopFonts.display};letter-spacing:-.03em}p{margin:14px 0 0;color:${desktopPalette.textMuted}}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.primary,.secondary{display:inline-flex;min-height:48px;align-items:center;justify-content:center;padding:0 20px;border-radius:12px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer}.primary{border:0;background:${desktopPalette.forest};color:${desktopPalette.paper}}.primary:hover:not(:disabled){background:${desktopPalette.forestHover}}.primary:disabled{cursor:wait;opacity:.78}.secondary{border:1px solid ${palette.border};background:transparent;color:${desktopPalette.forest}}.primary:focus-visible,.secondary:focus-visible{outline:3px solid ${desktopPalette.coral};outline-offset:3px}#status{min-height:24px;font-size:14px}#status:empty{display:none}`;
}

/** Runs in the browser: formats the reset date locally and drives the export download. */
function script(): string {
  return `(()=>{const COPY=${scriptLiteral(FAILURE_COPY)};const PREPARING=${scriptLiteral(PREPARING_COPY)};
const time=document.querySelector('time[datetime]');
if(time){const at=new Date(time.dateTime);if(Number.isFinite(at.getTime())){try{time.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'long'}).format(at);}catch(error){console.warn('Reset date format unavailable',error instanceof Error?error.name:'UnknownError');}}}
const button=document.getElementById('export');const status=document.getElementById('status');if(!button||!status)return;
const path=button.dataset.exportPath;
const failure=(code)=>code===409?COPY.in_progress:code===413?COPY.too_large:code===503?COPY.unavailable:COPY.failed;
const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const stamp=()=>new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z').replace(/[-:]/g,'');
const filename=(value)=>{const match=value?/filename="(matrix-export-\\d{8}T\\d{6}Z\\.tar\\.gz)"/.exec(value):null;return match?match[1]:'matrix-export-'+stamp()+'.tar.gz';};
const save=(blob,name)=>{const url=URL.createObjectURL(blob);try{const link=document.createElement('a');link.href=url;link.download=name;link.rel='noopener';document.body.append(link);link.click();link.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),0);}};
button.addEventListener('click',async()=>{button.disabled=true;status.textContent=PREPARING;
try{for(let retries=0;;retries++){
const response=await fetch(path,{headers:{'X-Matrix-Export':'1',accept:'application/gzip'},credentials:'include',signal:AbortSignal.timeout(${EXPORT_TIMEOUT_MS})});
const retryAfter=Number(response.headers.get('retry-after'));
if(response.status===503&&retries<${MAX_EXPORT_RETRIES}&&Number.isFinite(retryAfter)&&retryAfter>0){status.textContent=PREPARING;await wait(Math.min(retryAfter,${MAX_RETRY_DELAY_SECONDS})*1000);continue;}
if(!response.ok){status.textContent=failure(response.status);return;}
save(await response.blob(),filename(response.headers.get('content-disposition')));status.textContent='';return;}}
catch(error){console.warn('Export unavailable',error instanceof Error?error.name:'UnknownError');status.textContent=COPY.failed;}
finally{button.disabled=false;}});})();`;
}

export function renderComputeCapPage(input: ComputeCapPageInput): string {
  const at = new Date(input.resetsAt);
  const valid = Number.isFinite(at.getTime()) && at.toISOString() === input.resetsAt;
  const starts = valid
    ? `Your computer starts again on <time datetime="${escapeHtml(input.resetsAt)}">${escapeHtml(serverDate(at))}</time>.`
    : 'Your computer starts again when your monthly time resets.';
  const exportButton = input.exportPath === null ? ''
    : `<button class="primary" id="export" type="button" data-export-path="${escapeHtml(input.exportPath)}">Export my data</button>`;
  const nonce = escapeHtml(input.nonce);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${COMPUTE_CAP_TITLE}</title><style nonce="${nonce}">${styles()}</style></head>
<body><main aria-labelledby="title"><h1 id="title">${COMPUTE_CAP_TITLE}</h1>
<p>${starts} Your data is safe, and you can export it any time. A paid computer keeps working now.</p>
<div class="actions">${exportButton}<a class="secondary" href="${PLANS_PATH}">See paid plans</a></div>
<p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">${script()}</script></body></html>`;
}
