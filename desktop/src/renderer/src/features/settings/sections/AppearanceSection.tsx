import { Minus, Plus } from "@renderer/lib/hugeicons";
import { desktopShortcutLabel } from "@renderer/lib/platform-labels";
import { Button, IconButton } from "../../../design/primitives";
import { resolveThemeMode } from "../../../design/themes/apply";
import { MAX_ZOOM, MIN_ZOOM, useAppearance, ZOOM_STEP } from "../../../stores/appearance";
import { AppearanceControls } from "@matrix-os/ui/appearance";
import { Card, SettingsSectionHeader } from "./section-kit";
export default function AppearanceSection() {
  const appearance = useAppearance();
  const { zoom, setZoom } = appearance;
  return <>
    <SettingsSectionHeader title="Appearance" description="Make Matrix feel like home." />
    <Card>{!appearance.hydrated ? <p role={appearance.error ? "alert" : "status"}>{appearance.error ?? "Loading appearance…"}</p> : <AppearanceControls value={appearance} resolvedMode={resolveThemeMode(appearance.mode)} pending={appearance.pending || !appearance.hydrated} error={appearance.error} onChange={appearance.update} />}</Card>
      <Card>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Zoom</span>
        <div className="flex items-center gap-2">
          <IconButton
            label={`Zoom out (${desktopShortcutLabel("-")})`}
            disabled={!appearance.hydrated || appearance.pending || zoom <= MIN_ZOOM}
            onClick={() => setZoom(zoom - ZOOM_STEP)}
          >
            <Minus size={14} aria-hidden="true" />
          </IconButton>
          <span
            className="w-12 text-center text-sm tabular-nums"
            style={{ color: "var(--text-primary)" }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            label={`Zoom in (${desktopShortcutLabel("=")})`}
            disabled={!appearance.hydrated || appearance.pending || zoom >= MAX_ZOOM}
            onClick={() => setZoom(zoom + ZOOM_STEP)}
          >
            <Plus size={14} aria-hidden="true" />
          </IconButton>
          <Button variant="subtle" disabled={zoom === 1} onClick={() => setZoom(1)}>
            Reset
          </Button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Zooms the entire interface. {desktopShortcutLabel("=")}, {desktopShortcutLabel("-")}, and {desktopShortcutLabel("0")} work anywhere in the app.
        </p>
      </Card>
  </>;
}
