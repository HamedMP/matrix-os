import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Image, LoaderCircle, X } from "lucide-react";
import { Button, ContextMenu, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

const MAX_WALLPAPERS = 100;
const SAFE_WALLPAPER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WALLPAPER_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PRELOADED_WALLPAPERS = 12;

function wallpaperLabel(name: string): string {
  return name.replace(/\.[^.]+$/, "").split(/[-_]+/).filter(Boolean)
    .map((part) => part.toLowerCase() === "macos"
      ? "macOS"
      : part.toLowerCase() === "xp" ? "XP" : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function WallpaperPreview({
  name,
  api,
  previewUrl,
}: {
  name: string;
  api: ApiClient | null;
  previewUrl?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!api || previewUrl) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void api.getBlob(
      `/api/files/blob?path=${encodeURIComponent(`system/wallpapers/${name}`)}`,
      { maxBytes: WALLPAPER_PREVIEW_MAX_BYTES },
    ).then((blob) => {
      objectUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      setUrl(objectUrl);
    }).catch(() => {
      if (!cancelled) setUrl(null);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, name, previewUrl]);

  const resolvedUrl = previewUrl ?? url;
  if (!resolvedUrl) {
    return <span className="flex h-24 items-center justify-center bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><Image size={22} /></span>;
  }
  return <img src={resolvedUrl} alt={wallpaperLabel(name)} className="block h-24 w-full object-cover" />;
}

export default function DesktopBackgroundMenu({ children }: { children: ReactElement }) {
  const api = useConnection((state) => state.api);
  const requestRefresh = useUi((state) => state.requestDesktopBackgroundRefresh);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [wallpapers, setWallpapers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const previewUrlsRef = useRef<Record<string, string>>({});
  const previewLoadingRef = useRef(new Set<string>());
  const disposedRef = useRef(false);

  const preloadPreviews = useCallback(async (names: string[]) => {
    if (!api) return;
    const namesToLoad = names
      .filter((name) => !previewUrlsRef.current[name] && !previewLoadingRef.current.has(name))
      .slice(0, MAX_PRELOADED_WALLPAPERS);
    namesToLoad.forEach((name) => previewLoadingRef.current.add(name));
    const loaded = await Promise.all(namesToLoad.map(async (name) => {
      try {
        const blob = await api.getBlob(
          `/api/files/blob?path=${encodeURIComponent(`system/wallpapers/${name}`)}`,
          { maxBytes: WALLPAPER_PREVIEW_MAX_BYTES },
        );
        return [name, URL.createObjectURL(blob)] as const;
      } catch {
        return null;
      } finally {
        previewLoadingRef.current.delete(name);
      }
    }));
    const next = Object.fromEntries(loaded.filter((entry): entry is readonly [string, string] => entry !== null));
    if (Object.keys(next).length === 0) return;
    if (disposedRef.current) {
      Object.values(next).forEach((url) => URL.revokeObjectURL(url));
      return;
    }
    previewUrlsRef.current = { ...previewUrlsRef.current, ...next };
    setPreviewUrls(previewUrlsRef.current);
  }, [api]);

  const loadWallpapers = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<{ wallpapers?: unknown }>("/api/settings/wallpapers");
      const names = Array.isArray(result.wallpapers)
        ? result.wallpapers.filter((name): name is string => typeof name === "string" && SAFE_WALLPAPER.test(name)).slice(0, MAX_WALLPAPERS)
        : [];
      setWallpapers(names);
      void preloadPreviews(names);
    } catch (err: unknown) {
      setError(toUserMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, preloadPreviews]);

  useEffect(() => () => {
    disposedRef.current = true;
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (!chooserOpen) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, chooserOpen, releaseRendererOverlay]);

  useEffect(() => {
    if (!chooserOpen || !api) return;
    void loadWallpapers();
  }, [chooserOpen, loadWallpapers]);

  const save = useCallback(async (background: { type: "wallpaper"; name: string } | { type: "pattern" }) => {
    if (!api || saving) return;
    const key = background.type === "wallpaper" ? background.name : "pattern";
    setSaving(key);
    setError(null);
    try {
      await api.patch("/api/settings/desktop", { background });
      requestRefresh();
      setChooserOpen(false);
    } catch (err: unknown) {
      setError(toUserMessage(err));
    } finally {
      setSaving(null);
    }
  }, [api, requestRefresh, saving]);

  return (
    <>
      <ContextMenu onOpenChange={(open) => {
        if (open) void loadWallpapers();
      }} items={[
        { label: "Change background…", onSelect: () => setChooserOpen(true) },
        { label: "Use Matrix gradient", disabled: !api, onSelect: () => void save({ type: "pattern" }) },
      ]}>{children}</ContextMenu>
      <Dialog open={chooserOpen} onClose={() => setChooserOpen(false)} title="Desktop background" width={560} placement="center">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Desktop background</h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-tertiary)" }}>Choose a wallpaper stored on this Matrix computer.</p>
          </div>
          <Button variant="ghost" onClick={() => setChooserOpen(false)} aria-label="Close background picker"><X size={16} /></Button>
        </div>
        <div className="max-h-[min(520px,65vh)] overflow-y-auto p-5">
          {loading ? <div className="flex items-center justify-center gap-2 py-12 text-sm" style={{ color: "var(--text-tertiary)" }}><LoaderCircle className="animate-spin" size={16} /> Loading backgrounds…</div> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <button type="button" aria-label="Matrix Gradient" disabled={saving !== null} onClick={() => void save({ type: "pattern" })} className="overflow-hidden rounded-xl border text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={{ borderColor: "var(--border-subtle)" }}>
                <span className="block h-24" style={{ background: "radial-gradient(ellipse at 20% 80%, #323D2E 0%, transparent 60%), radial-gradient(ellipse at 80% 15%, #B8C4A8 0%, transparent 55%), #9AA48C" }} />
                <span className="flex h-10 items-center justify-between px-3 text-xs font-medium" style={{ color: "var(--text-primary)" }}>Matrix Gradient {saving === "pattern" ? <LoaderCircle className="animate-spin" size={13} /> : null}</span>
              </button>
              {wallpapers.map((name) => (
                <button key={name} type="button" aria-label={wallpaperLabel(name)} disabled={saving !== null} onClick={() => void save({ type: "wallpaper", name })} className="overflow-hidden rounded-xl border text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={{ borderColor: "var(--border-subtle)" }}>
                  {saving === name
                    ? <span className="flex h-24 items-center justify-center bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}><LoaderCircle className="animate-spin" size={22} /></span>
                    : <WallpaperPreview name={name} api={api} previewUrl={previewUrls[name]} />}
                  <span className="block h-10 truncate px-3 py-3 text-xs font-medium" style={{ color: "var(--text-primary)" }}>{wallpaperLabel(name)}</span>
                </button>
              ))}
            </div>
          )}
          {error ? <p role="alert" className="mt-4 text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
        </div>
      </Dialog>
    </>
  );
}
