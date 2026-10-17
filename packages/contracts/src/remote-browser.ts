/** One durable identity per product presentation; both share the owner Linux display. */
export const REMOTE_BROWSER_PATHS = { browser: "__browser__", desktop: "__cloud-desktop__" } as const;
export type RemoteBrowserSurface = keyof typeof REMOTE_BROWSER_PATHS;

export function remoteBrowserSurfaceForPath(path: string): RemoteBrowserSurface | null {
  if ([REMOTE_BROWSER_PATHS.browser, "apps/browser/index.html", "apps/browser/dist/index.html"].includes(path)) return "browser";
  return path === REMOTE_BROWSER_PATHS.desktop ? "desktop" : null;
}

/** Chrome needs most of the work area, while saved owner geometry remains authoritative. */
export function remoteBrowserWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const fit = (value: number) => {
    const available = Math.max(1, Number.isFinite(value) ? value : 1);
    return Math.max(1, Math.min(Math.round(available * 0.9), available - Math.min(40, available - 1)));
  };
  return { width: fit(workArea.width), height: fit(workArea.height) };
}
