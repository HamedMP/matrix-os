import { Download, LoaderCircle } from "lucide-react";
import { useDesktopUpdate } from "../../stores/desktop-update";

interface DesktopUpdateButtonProps {
  collapsed: boolean;
}

export default function DesktopUpdateButton({ collapsed }: DesktopUpdateButtonProps) {
  const snapshot = useDesktopUpdate((state) => state.snapshot);
  const installing = useDesktopUpdate((state) => state.installing);
  const install = useDesktopUpdate((state) => state.install);

  if (snapshot.status !== "ready" || !snapshot.version) return null;

  const label = `Update Matrix OS to ${snapshot.version}`;
  return (
    <div className={`px-2 pt-1 ${collapsed ? "flex justify-center" : ""}`}>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={installing}
        className={`no-drag flex h-7 items-center rounded-md text-white shadow-sm transition-[transform,filter] duration-150 hover:brightness-110 active:scale-[0.99] disabled:cursor-wait disabled:opacity-80 ${collapsed ? "w-7 justify-center" : "w-full gap-2 px-2.5 text-xs font-semibold"}`}
        style={{ background: "var(--update-action)" }}
        onClick={() => void install()}
      >
        {installing ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Download size={14} className="shrink-0" />}
        {!collapsed ? (
          <>
            <span>Update</span>
            <span className="ml-auto opacity-75">v{snapshot.version}</span>
          </>
        ) : null}
      </button>
    </div>
  );
}
