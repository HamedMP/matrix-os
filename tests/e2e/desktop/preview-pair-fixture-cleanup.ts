import type { ElectronApplication } from "playwright";
import { stopOwnedPreviewChild } from "../../../scripts/preview-pair/desktop-process.js";

/** Fixture teardown is bounded independently of Electron's before-quit drains.
 * Only the child handle returned by this test's launch may be stopped. */
export async function closeOwnedPreviewFixture(app: Pick<ElectronApplication, "process" | "close">, timeoutMs = 5_000) {
  const child = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          console.warn("[preview-pair-e2e] forcing owned fixture shutdown", child.pid);
          void stopOwnedPreviewChild(child).then(resolve, reject);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await stopOwnedPreviewChild(child);
  }
}
