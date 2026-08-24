import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Image, LoaderCircle, X } from "lucide-react";
import { Button, ContextMenu, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

const MAX_WALLPAPERS = 100;
const SAFE_WALLPAPER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function wallpaperLabel(name: string): string {
  return name.replace(/\.[^.]+$/, "").split(/[-_]+/).filter(Boolean)
    .map((part) => part.toLowerCase() === "macos"
      ? "macOS"
      : part.toLowerCase() === "xp" ? "XP" : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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

  useEffect(() => {
    if (!chooserOpen) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, chooserOpen, releaseRendererOverlay]);

  useEffect(() => {
    if (!chooserOpen || !api) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api.get<{ wallpapers?: unknown }>("/api/settings/wallpapers")
      .then((result) => {
        if (cancelled) return;
        setWallpapers(Array.isArray(result.wallpapers)
          ? result.wallpapers.filter((name): name is string => typeof name === "string" && SAFE_WALLPAPER.test(name)).slice(0, MAX_WALLPAPERS)
          : []);
      })
      .catch((err: unknown) => { if (!cancelled) setError(toUserMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, chooserOpen]);

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
      <ContextMenu items={[
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
              <button type="button" aria-label="Matrix Gradient" disabled={saving !== null} onClick={() => void save({ type: "pattern" })} className="overflow-hidden rounded-xl border text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={{ borderColor: "var(--border-subtle)" }}>
                <span className="block h-24 bg-[radial-gradient(ellipse_at_20%_80%,#323D2E_0%,transparent_60%),radial-gradient(ellipse_at_80%_15%,#B8C4A8_0%,transparent_55%),#9AA48C]" />
                <span className="flex h-10 items-center justify-between px-3 text-xs font-medium" style={{ color: "var(--text-primary)" }}>Matrix Gradient {saving === "pattern" ? <LoaderCircle className="animate-spin" size={13} /> : null}</span>
              </button>
              {wallpapers.map((name) => (
                <button key={name} type="button" aria-label={wallpaperLabel(name)} disabled={saving !== null} onClick={() => void save({ type: "wallpaper", name })} className="overflow-hidden rounded-xl border text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50" style={{ borderColor: "var(--border-subtle)" }}>
                  <span className="flex h-24 items-center justify-center bg-[var(--bg-hover)]" style={{ color: "var(--text-tertiary)" }}>{saving === name ? <LoaderCircle className="animate-spin" size={22} /> : <Image size={22} />}</span>
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
