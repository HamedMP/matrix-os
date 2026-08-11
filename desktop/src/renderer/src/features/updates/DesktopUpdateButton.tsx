import { Download, LoaderCircle } from "lucide-react";
import { useDesktopUpdate } from "../../stores/desktop-update";

export default function DesktopUpdateButton() {
  const snapshot = useDesktopUpdate((state) => state.snapshot);
  const installing = useDesktopUpdate((state) => state.installing);
  const install = useDesktopUpdate((state) => state.install);

  if (snapshot.status !== "ready" || !snapshot.version) return null;

  const label = `Update Matrix OS to ${snapshot.version}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={installing}
      className="no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-110 active:scale-95 disabled:cursor-wait disabled:opacity-80"
      style={{ background: "var(--update-action)" }}
      onClick={() => void install()}
    >
      {installing ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
    </button>
  );
}
