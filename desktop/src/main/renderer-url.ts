export const DESKTOP_DEV_RENDERER_HOST = "desktop.local.matrix-os.com";

const LOCAL_RENDERER_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resolveDesktopRendererUrl(rendererUrl: string | undefined): string | undefined {
  if (!rendererUrl) return rendererUrl;
  try {
    const parsed = new URL(rendererUrl);
    if (parsed.protocol !== "http:" || !LOCAL_RENDERER_HOSTS.has(parsed.hostname)) {
      return rendererUrl;
    }
    parsed.hostname = DESKTOP_DEV_RENDERER_HOST;
    return parsed.toString();
  } catch {
    return rendererUrl;
  }
}

export function desktopDevHostResolverRules(): string {
  return `MAP ${DESKTOP_DEV_RENDERER_HOST} 127.0.0.1`;
}

