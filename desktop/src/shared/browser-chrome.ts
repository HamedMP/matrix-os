// Channels for Browser title bar chrome between the Browser embed and main.
export const BROWSER_CHROME_PUBLISH_CHANNEL = "matrix:browser-chrome:publish";
export const BROWSER_CHROME_ACTION_CHANNEL = "matrix:browser-chrome:action";

interface ChromeIpc {
  send(channel: string, value: unknown): void;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

/** Page-facing client. Main validates every model and action again. */
export function createNativeBrowserChromeClient(ipc: ChromeIpc) {
  return Object.freeze({
    publish(model: unknown): void { ipc.send(BROWSER_CHROME_PUBLISH_CHANNEL, model); },
    onAction(handler: (action: string) => void): () => void {
      const listener = (_event: unknown, value: unknown) => { if (typeof value === "string") handler(value); };
      ipc.on(BROWSER_CHROME_ACTION_CHANNEL, listener);
      return () => { ipc.removeListener(BROWSER_CHROME_ACTION_CHANNEL, listener); };
    },
  });
}
