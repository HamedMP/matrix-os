import type { WebContents } from "electron";

interface PreviewWindow {
  isDestroyed(): boolean;
  webContents: WebContents;
}
const unavailable = () => new Error("Preview window is unavailable");

async function loaded(contents: WebContents, waitForNavigation = false) {
  if (contents.isDestroyed()) throw unavailable();
  if (!waitForNavigation && contents.isCrashed()) throw unavailable();
  const url = contents.getURL();
  if (!waitForNavigation && !contents.isLoadingMainFrame() && url && url !== "about:blank") return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      contents.removeListener("did-finish-load", ready);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("destroyed", destroyed);
      contents.removeListener("render-process-gone", destroyed);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish(), destroyed = () => finish(unavailable());
    const failed = (_event: unknown, _code: number, _description: string, _url: string, mainFrame: boolean) => {
      if (mainFrame) finish(unavailable());
    };
    const timer = setTimeout(destroyed, 15_000);
    contents.once("did-finish-load", ready);
    contents.on("did-fail-load", failed);
    contents.once("destroyed", destroyed);
    contents.once("render-process-gone", destroyed);
  });
}

/** Share one bounded creation/readiness promise between Dock activation and a
 * verified second-instance request. No sessions or authorization live here. */
export function createPreviewWindowReopener(options: {
  current(): PreviewWindow | null; open(): Promise<void>; focus(): void;
}) {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const current = options.current();
      if (!current || current.isDestroyed()) await options.open();
      const window = options.current();
      if (!window || window.isDestroyed()) throw unavailable();
      const reload = window.webContents.isCrashed();
      if (reload) window.webContents.reload();
      // A crashed renderer retains its URL. Require its new main-frame load;
      // the old idle URL cannot stand in for successful recovery.
      await loaded(window.webContents, reload);
      if (window.isDestroyed() || options.current() !== window || window.webContents.isCrashed()) throw unavailable();
      options.focus();
    })().finally(() => { pending = undefined; });
    return pending;
  };
}
