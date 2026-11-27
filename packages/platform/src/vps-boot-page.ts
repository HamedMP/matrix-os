import { matrixBootStyles } from "@matrix-os/brand/boot-screen";
import { RUNTIME_WAKE_MESSAGES } from "@matrix-os/contracts/runtime-lifecycle";

interface BootPageCopy {
  title: string;
  detail: string;
  /** Seconds before the page checks again. */
  refreshSeconds: number;
}

/**
 * `waking` and `busy` come from an on-demand (metal) computer: a free computer
 * wakes in seconds, so the page says so and checks back sooner (spec 2691, ENG-520).
 */
function bootPageCopy(status: string): BootPageCopy {
  switch (status) {
    case "recovering":
      return {
        title: "Restoring Matrix OS",
        detail: "Matrix is restoring your workspace and will bring you back automatically.",
        refreshSeconds: 8,
      };
    case "waking":
      return {
        title: "Waking your Matrix computer",
        detail: "Matrix is waking your computer. It opens in a few seconds.",
        refreshSeconds: 3,
      };
    case "busy":
      return {
        title: "Matrix is at capacity",
        detail: RUNTIME_WAKE_MESSAGES.runtime_busy,
        refreshSeconds: 8,
      };
    default:
      return {
        title: "Booting Matrix OS",
        detail: "Matrix is preparing your cloud computer. This usually takes a couple of minutes.",
        refreshSeconds: 8,
      };
  }
}

/** Platform-only fallback: the computer cannot serve its own shell yet. */
export function getVpsBootPage(input: { status: string }): string {
  const { title, detail, refreshSeconds } = bootPageCopy(input.status);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${refreshSeconds}">
  <title>${title}</title>
  <style>${matrixBootStyles}</style>
</head>
<body>
  <main class="matrix-boot-screen" role="status" aria-live="polite" aria-label="${title}">
    <div class="matrix-boot-mark" role="img" aria-label="Matrix OS logo"></div>
    <h1 class="matrix-boot-sr-only">${title}</h1>
    <p class="matrix-boot-sr-only">${detail}</p>
  </main>
</body>
</html>`;
}
