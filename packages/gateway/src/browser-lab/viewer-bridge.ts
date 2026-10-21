/** Observe the installed Kasm client's transport class without a second UI singleton. */
export function attachViewerBridge(ui?: any, environment: any = {}) {
  const host = environment.window ?? window;
  const page = environment.document ?? document;
  const Observer = environment.MutationObserver ?? MutationObserver;
  const targetOrigin = environment.targetOrigin ?? page.querySelector?.('meta[name="matrix-parent-origin"]')?.content ?? host.location.origin;
  const target = new URL(targetOrigin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.origin !== targetOrigin) throw new Error('Invalid parent origin');
  let current: any;
  let disposed = false;
  let last: boolean | undefined;
  const notify = (connected: boolean) => {
    if (disposed || last === connected) return;
    last = connected;
    host.parent.postMessage({ type: "matrix-browser-viewer", connected }, targetOrigin);
  };
  const connected = () => notify(true);
  const disconnected = () => notify(false);
  const unbind = () => {
    current?.removeEventListener("connect", connected);
    current?.removeEventListener("disconnect", disconnected);
  };
  const bind = () => {
    if (disposed) return;
    if (current !== ui?.rfb) {
      unbind(); current = ui?.rfb;
      current?.addEventListener("connect", connected);
      current?.addEventListener("disconnect", disconnected);
    }
    // Bundled clients do not export their RFB singleton. This class belongs to
    // viewer transport state; it never reads the streamed application page.
    notify(page.documentElement.classList.contains("noVNC_connected"));
  };
  const observer = new Observer(bind);
  observer.observe(page.documentElement, { attributes: true, attributeFilter: ["class"] });
  bind();
  const dispose = () => { if (disposed) return; notify(false); disposed = true; unbind(); observer.disconnect(); host.removeEventListener("pagehide", dispose); };
  host.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}

export const VIEWER_BRIDGE_SCRIPT = `(${attachViewerBridge.toString()})();\n`;
export function injectViewerBridge(html: string, parentOrigin?: string): string {
  if (html.length > 500_000 || !/<\/body>/i.test(html)) throw new Error("Invalid viewer HTML");
  let meta = '';
  if (parentOrigin) {
    const parsed = new URL(parentOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== parentOrigin) throw new Error('Invalid parent origin');
    meta = `<meta name="matrix-parent-origin" content="${parsed.origin}">`;
  }
  return html.replace(/<\/body>/i, `${meta}<script type="module" src="./matrix-viewer-bridge.mjs"></script></body>`);
}
