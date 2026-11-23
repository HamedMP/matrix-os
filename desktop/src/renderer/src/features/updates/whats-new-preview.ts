type PreviewEnv = { DEV?: boolean; VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW?: string };

/**
 * Dev-only: `VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW=1 pnpm --dir desktop dev`
 * opens What's New on launch so the release notes can be reviewed.
 */
export function whatsNewPreviewRequested(env: PreviewEnv = import.meta.env): boolean {
  return env.DEV === true && env.VITE_MATRIX_DESKTOP_PREVIEW_WHATS_NEW === "1";
}
