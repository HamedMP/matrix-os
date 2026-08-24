import { useEffect, useState, type CSSProperties } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ApiClient } from "../../lib/api";
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

export default function DesktopBackground() {
  const api = useConnection((state) => state.api);
  const requestedRefresh = useUi((state) => state.desktopBackgroundRefreshRequest);
  const [loaded, setLoaded] = useState<{ api: ApiClient; style: CSSProperties } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const style = api && loaded?.api === api ? loaded.style : FALLBACK_STYLE;

  useEffect(() => {
    const refresh = () => setRefreshRevision((revision) => revision + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let ownedObjectUrl: string | null = null;

    if (api) {
      void (async () => {
        const config = await api.get<{ background?: unknown }>("/api/settings/desktop");
        const background = backgroundConfig(config?.background);
        if (!background) return;
        if (background.type !== "wallpaper") {
          if (!cancelled) setLoaded({ api, style: directBackgroundStyle(background) });
          return;
        }

        const path = `system/wallpapers/${background.name}`;
        const blob = await api.getBlob(
          `/api/files/blob?path=${encodeURIComponent(path)}`,
          { maxBytes: WALLPAPER_MAX_BYTES },
        );
        const objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        ownedObjectUrl = objectUrl;
        setLoaded({
          api,
          style: {
            backgroundImage: `url("${objectUrl}")`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          },
        });
      })()
        .catch(() => {
          if (!cancelled) console.warn("[desktop-background] configured background unavailable");
        });
    }

    return () => {
      cancelled = true;
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl);
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
