import type { BrowserWindow, MessageBoxOptions, RenderProcessGoneDetails, WebContents } from "electron";

type RecoveryWindow = Pick<BrowserWindow, "on" | "isDestroyed" | "close" | "show"> & {
  webContents: Pick<WebContents, "on" | "removeListener" | "isDestroyed" | "reload">;
};

/** Native recovery survives renderer process loss, when React cannot show UI.
 * Reload is owner-triggered and never resubmits Chat requests or resets data. */
export function installRendererRecovery(window: RecoveryWindow, dependencies: {
  showMessage: (options: MessageBoxOptions) => Promise<{ response: number }>;
  reportError: (error: unknown) => void;
}): void {
  let closed = false;
  let pending = false;
  const contents = window.webContents;
  const available = () => !closed && !window.isDestroyed() && !contents.isDestroyed();

  async function offerRecovery(): Promise<void> {
    if (pending || !available()) return;
    pending = true;
    try {
      window.show();
      const { response } = await dependencies.showMessage({
        type: "error",
        title: "Matrix OS",
        message: "Matrix OS couldn’t open this window",
        detail: "Reload the window to try again.",
        buttons: ["Reload window", "Close window"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (!available()) return;
      if (response === 0) contents.reload();
      else window.close();
    } catch (error: unknown) {
      dependencies.reportError(error);
    } finally {
      pending = false;
    }
  }

  function onRendererGone(_event: unknown, details: RenderProcessGoneDetails): void {
    if (details.reason !== "clean-exit") void offerRecovery();
  }
  function onLoadFailed(_event: unknown, errorCode: number, _description: string, _url: string, isMainFrame: boolean): void {
    if (isMainFrame && errorCode !== -3) void offerRecovery(); // ERR_ABORTED is normal navigation/reload.
  }
  contents.on("render-process-gone", onRendererGone);
  contents.on("did-fail-load", onLoadFailed);
  window.on("closed", () => {
    closed = true;
    contents.removeListener("render-process-gone", onRendererGone);
    contents.removeListener("did-fail-load", onLoadFailed);
  });
}
