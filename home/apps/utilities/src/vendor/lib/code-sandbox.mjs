/** A disposable, opaque-origin iframe hosts each run; its worker has no site storage. */
const FRAME_DOCUMENT = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"></head><body><script>
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.data || event.data.type !== 'run') return;
  const nonce = event.data.nonce;
  const workerSource = \`const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const send = self.postMessage.bind(self);
  for (const name of ['postMessage', 'Worker', 'SharedWorker', 'importScripts', 'BroadcastChannel']) {
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  self.onmessage = async function(event) {
    const lines = [];
    const format = (value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    const write = (...args) => { if (lines.length < 100) lines.push(args.map(format).join(' ').slice(0, 2000)); };
    const safeConsole = { log: write, info: write, warn: write, error: write };
    try {
      const fn = new AsyncFunction('console', event.data);
      const result = await fn(safeConsole);
      if (result !== undefined) write(result);
      send({ type: 'done', output: lines.join('\\\\n') || 'Completed without console output.' });
    } catch (error) {
      send({ type: 'error', output: error instanceof Error ? error.message.slice(0, 1000) : 'Execution failed.' });
    }
  };\`;
  const blobUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
  let worker;
  try { worker = new Worker(blobUrl); }
  catch { URL.revokeObjectURL(blobUrl); parent.postMessage({ type: 'error', nonce, output: 'This browser blocked the isolated worker.' }, '*'); return; }
  URL.revokeObjectURL(blobUrl);
  const timer = setTimeout(() => { worker.terminate(); parent.postMessage({ type: 'error', nonce, output: 'Code exceeded the 3-second limit.' }, '*'); }, 3000);
  worker.onmessage = function (message) {
    clearTimeout(timer); worker.terminate();
    const data = message.data || {};
    parent.postMessage({ type: data.type === 'done' ? 'done' : 'error', nonce, output: String(data.output || '').slice(0, 200000) }, '*');
  };
  worker.onerror = function () { clearTimeout(timer); worker.terminate(); parent.postMessage({ type: 'error', nonce, output: 'The isolated worker failed.' }, '*'); };
  worker.postMessage(event.data.code);
});
</script></body></html>`;

export function runCodeInSandbox(code) {
  if (typeof document === "undefined" || !globalThis.crypto?.randomUUID) return Promise.reject(new Error("This browser cannot create an isolated code workspace."));
  if (typeof code !== "string" || code.length > 40_000) return Promise.reject(new Error("Compiled code is too large."));
  const nonce = globalThis.crypto.randomUUID();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.style.display = "none";
  frame.srcdoc = FRAME_DOCUMENT;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { window.removeEventListener("message", onMessage); clearTimeout(timer); frame.remove(); };
    const finish = (result, failed) => {
      if (settled) return;
      settled = true; cleanup();
      failed ? reject(new Error(result)) : resolve(result);
    };
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== "null" || event.data?.nonce !== nonce) return;
      if (event.data.type !== "done" && event.data.type !== "error") return;
      const output = String(event.data.output || "").slice(0, 100_000);
      finish(output, event.data.type === "error");
    };
    const timer = setTimeout(() => finish("Code exceeded the 3-second limit.", true), 3500);
    window.addEventListener("message", onMessage);
    frame.onload = () => { if (!settled) frame.contentWindow?.postMessage({ type: "run", nonce, code }, "*"); };
    document.body.appendChild(frame);
  });
}
