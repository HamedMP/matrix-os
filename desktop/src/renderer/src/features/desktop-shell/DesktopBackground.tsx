import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ApiClient } from "../../lib/api";
import { loadNativeDesktopConfig } from "../../lib/desktop-config-client";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

type DesktopBackgroundConfig =
  | { type: "pattern" }
  | { type: "solid"; color: string }
  | { type: "gradient"; from: string; to: string; angle?: number }
  | { type: "wallpaper"; name: string }
  | { type: "image"; url: string; fit?: string };

const FALLBACK_STYLE: CSSProperties = { background: "var(--bg-app)" };
const WALLPAPER_MAX_BYTES = 10 * 1024 * 1024;

function meshGradient(): string {
  return [
    "radial-gradient(ellipse at 20% 80%, var(--gradient-deep, #323D2E) 0%, transparent 60%)",
    "radial-gradient(ellipse at 80% 15%, var(--gradient-light, #B8C4A8) 0%, transparent 55%)",
    "radial-gradient(ellipse at 50% 50%, var(--gradient-mid, #9AA48C) 0%, transparent 70%)",
    "radial-gradient(ellipse at 75% 70%, var(--gradient-accent, #6a8a7a) 0%, transparent 50%)",
    "radial-gradient(ellipse at 10% 20%, var(--gradient-deep, #323D2E) 0%, transparent 45%)",
    "var(--gradient-mid, #9AA48C)",
  ].join(", ");
}

function backgroundConfig(value: unknown): DesktopBackgroundConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  switch (candidate.type) {
    case "pattern":
      return { type: "pattern" };
    case "solid":
      return typeof candidate.color === "string" ? { type: "solid", color: candidate.color } : null;
    case "gradient":
      return typeof candidate.from === "string" && typeof candidate.to === "string"
        ? {
            type: "gradient",
            from: candidate.from,
            to: candidate.to,
            ...(typeof candidate.angle === "number" && Number.isFinite(candidate.angle)
              ? { angle: candidate.angle }
              : {}),
          }
        : null;
    case "wallpaper":
      return typeof candidate.name === "string"
        && candidate.name.length > 0
        && candidate.name.length <= 255
        && !candidate.name.includes("/")
        && !candidate.name.includes("\\")
        && candidate.name !== "."
        && candidate.name !== ".."
        ? { type: "wallpaper", name: candidate.name }
        : null;
    case "image":
      return typeof candidate.url === "string"
        ? {
            type: "image",
            url: candidate.url,
            ...(typeof candidate.fit === "string" ? { fit: candidate.fit } : {}),
          }
        : null;
    default:
      return null;
  }
}

function directBackgroundStyle(config: Exclude<DesktopBackgroundConfig, { type: "wallpaper" }>): CSSProperties {
  switch (config.type) {
    case "pattern":
      return { background: meshGradient(), backgroundAttachment: "fixed" };
    case "solid":
      return { backgroundColor: config.color };
    case "gradient":
      return { background: `linear-gradient(${config.angle ?? 135}deg, ${config.from}, ${config.to})` };
    case "image":
      return {
        backgroundImage: `url("${config.url.replaceAll('"', '\\"')}")`,
        backgroundSize: config.fit ?? "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
  }
}

async function wallpaperObjectUrl(blob: Blob): Promise<string> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("wallpaper image could not be loaded"));
      image.src = objectUrl;
    });
    return objectUrl;
  } catch (err: unknown) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

export default function DesktopBackground() {
  const api = useConnection((state) => state.api);
  const requestedRefresh = useUi((state) => state.desktopBackgroundRefreshRequest);
  const [loaded, setLoaded] = useState<{ api: ApiClient; style: CSSProperties } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const activeObjectUrl = useRef<{ api: ApiClient; url: string } | null>(null);
  const loadedConfigApi = useRef<ApiClient | null>(null);
  const style = api && loaded?.api === api ? loaded.style : FALLBACK_STYLE;

  useEffect(() => {
    const refresh = () => setRefreshRevision((revision) => revision + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => () => {
    const current = activeObjectUrl.current;
    if (!current) return;
    activeObjectUrl.current = null;
    URL.revokeObjectURL(current.url);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const previousRuntimeObjectUrl = activeObjectUrl.current;
    if (previousRuntimeObjectUrl && previousRuntimeObjectUrl.api !== api) {
      activeObjectUrl.current = null;
      URL.revokeObjectURL(previousRuntimeObjectUrl.url);
    }

    const releaseAfterPaint = (url: string): void => {
      const release = () => URL.revokeObjectURL(url);
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(release);
      } else {
        queueMicrotask(release);
      }
    };

    if (api) {
      void (async () => {
        const refresh = loadedConfigApi.current === api;
        loadedConfigApi.current = api;
        const config = await loadNativeDesktopConfig(api, { refresh });
        const background = backgroundConfig(
          typeof config === "object" && config !== null && !Array.isArray(config)
            ? (config as { background?: unknown }).background
            : undefined,
        );
        if (!background) return;
        if (background.type !== "wallpaper") {
          if (!cancelled) {
            const previous = activeObjectUrl.current;
            activeObjectUrl.current = null;
            setLoaded({ api, style: directBackgroundStyle(background) });
            if (previous) releaseAfterPaint(previous.url);
          }
          return;
        }

        const path = `system/wallpapers/${background.name}`;
        const blob = await api.getBlob(
          `/api/files/blob?path=${encodeURIComponent(path)}`,
          { maxBytes: WALLPAPER_MAX_BYTES },
        );
        const objectUrl = await wallpaperObjectUrl(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        const previous = activeObjectUrl.current;
        activeObjectUrl.current = { api, url: objectUrl };
        setLoaded({
          api,
          style: {
            backgroundImage: `url("${objectUrl}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          },
        });
        if (previous) releaseAfterPaint(previous.url);
      })()
        .catch(() => {
          if (!cancelled) console.warn("[desktop-background] configured background unavailable");
        });
    }

    return () => {
      cancelled = true;
    };
  }, [api, refreshRevision, requestedRefresh]);

  return (
    <div
      data-testid="desktop-background"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{ ...style, zIndex: DESKTOP_Z_INDEX.nativeDesktopBackground }}
    />
  );
}
