import { matrixBootStyles } from "@matrix-os/brand/boot-screen";

/** Platform-only fallback: the VPS cannot serve its own shell yet. */
export function getVpsBootPage(input: { status: string }): string {
  const title = input.status === "recovering" ? "Restoring Matrix OS" : "Booting Matrix OS";
  const detail = input.status === "recovering"
    ? "Matrix is restoring your workspace and will bring you back automatically."
    : "Matrix is preparing your cloud computer. This usually takes a couple of minutes.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="8">
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
