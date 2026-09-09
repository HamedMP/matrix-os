import { createTerminalPasteAssetCleanupLifecycle } from "./paste-assets.js";

export interface TerminalPasteAssetCleanupRuntime {
  close(): Promise<void>;
}

export function startTerminalPasteAssetCleanup(options: {
  homePath: string;
  onFailure: (context: string, error: unknown) => void;
}): TerminalPasteAssetCleanupRuntime {
  const lifecycle = createTerminalPasteAssetCleanupLifecycle({
    homePath: options.homePath,
    onError: (error) => options.onFailure("Temporary terminal paste cleanup failed", error),
  });
  void lifecycle.runNow().catch((error: unknown) => {
    options.onFailure("Initial temporary terminal paste cleanup failed", error);
  });

  return {
    async close() {
      lifecycle.close();
      await lifecycle.waitForIdle().catch((error: unknown) => {
        options.onFailure("Temporary terminal paste cleanup shutdown failed", error);
      });
    },
  };
}
