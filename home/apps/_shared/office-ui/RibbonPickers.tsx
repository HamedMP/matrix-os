import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cx, moveFocus } from "./internal";
import { Popover } from "./Popover";
import { Chevron, tooltipFor } from "./ribbon-parts";
import type { RibbonColorItem, RibbonColorSwatch, RibbonGalleryItem } from "./ribbon-types";

/** Document colours offered by default (text and fill colours, not UI styling). */
export const DEFAULT_RIBBON_PALETTE: readonly RibbonColorSwatch[] = [
  { value: "#000000", name: "Black" },
  { value: "#404040", name: "Dark gray" },
  { value: "#808080", name: "Gray" },
  { value: "#bfbfbf", name: "Light gray" },
  { value: "#ffffff", name: "White" },
  { value: "#7f1d1d", name: "Dark red" },
  { value: "#dc2626", name: "Red" },
  { value: "#ea580c", name: "Orange" },
  { value: "#facc15", name: "Yellow" },
  { value: "#84cc16", name: "Light green" },
  { value: "#16a34a", name: "Green" },
  { value: "#0d9488", name: "Teal" },
  { value: "#38bdf8", name: "Light blue" },
  { value: "#2563eb", name: "Blue" },
  { value: "#1e3a8a", name: "Dark blue" },
  { value: "#7c3aed", name: "Purple" },
];

const MAX_RECENT_COLORS = 8;
let recent: string[] = [];

/** Colours picked most recently across every colour button, newest first (at most 8). */
export function recentColors(): readonly string[] {
  return recent;
}

export function rememberColor(color: string): void {
  const key = color.toLowerCase();
  recent = [color, ...recent.filter((entry) => entry.toLowerCase() !== key)].slice(0, MAX_RECENT_COLORS);
}

export function clearRecentColors(): void {
  recent = [];
}

function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])"));
  if (moveFocus(buttons, document.activeElement, event.key, "horizontal") >= 0) event.preventDefault();
}

/** Split colour button with a palette popover, recent colours and a custom colour input. */
export function RibbonColorControl({ item }: { item: RibbonColorItem }) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const palette = item.palette ?? DEFAULT_RIBBON_PALETTE;
  const optionsLabel = `${item.label} options`;
  const nameOf = (color: string) => palette.find((swatch) => swatch.value.toLowerCase() === color.toLowerCase())?.name ?? color;
  const choose = (color: string | null) => {
    if (color) rememberColor(color);
    setOpen(false);
    item.onChange(color);
  };
  const swatch = (color: string, name: string) => (
    <button
      key={color}
      type="button"
      className="oui-ribbon__swatch-color"
      style={{ background: color }}
      aria-label={name}
      title={name}
      aria-pressed={item.value?.toLowerCase() === color.toLowerCase()}
      onClick={() => choose(color)}
    />
  );
  const latest = recentColors();

  return (
    <span className="oui-ribbon__split oui-ribbon__split--small">
      <button
        type="button"
        className="oui-ribbon__button oui-ribbon__button--small is-icon-only oui-ribbon__split-main"
        aria-label={item.label}
        aria-keyshortcuts={item.shortcut}
        title={tooltipFor(item.value ? `${item.label}: ${nameOf(item.value)}` : item.label, item.shortcut)}
        disabled={item.disabled}
        onClick={() => item.onChange(item.value)}
      >
        <span className="oui-ribbon__icon oui-ribbon__color-face" aria-hidden="true">
          {item.icon ?? "A"}
          <span className="oui-ribbon__color-bar" style={{ background: item.value ?? "transparent" }} />
        </span>
      </button>
      <button
        ref={arrowRef}
        type="button"
        className="oui-ribbon__button oui-ribbon__split-arrow"
        aria-label={optionsLabel}
        title={optionsLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={item.disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={arrowRef} label={item.label} className="oui-ribbon__palette">
        {item.allowNone && (
          <button type="button" className="oui-menu__item" aria-pressed={item.value === null} onClick={() => choose(null)}>
            {item.noneLabel ?? "Automatic"}
          </button>
        )}
        <p className="oui-ribbon__palette-heading" id={`${headingId}-palette`}>Colours</p>
        <div className="oui-ribbon__palette-grid" role="group" aria-labelledby={`${headingId}-palette`} onKeyDown={onGridKeyDown}>
          {palette.map((entry) => swatch(entry.value, entry.name))}
        </div>
        {latest.length > 0 && (
          <>
            <p className="oui-ribbon__palette-heading" id={`${headingId}-recent`}>Recent colours</p>
            <div className="oui-ribbon__palette-grid" role="group" aria-labelledby={`${headingId}-recent`} onKeyDown={onGridKeyDown}>
              {latest.map((color) => swatch(color, nameOf(color)))}
            </div>
          </>
        )}
        <label className="oui-ribbon__custom-color">
          <input
            type="color"
            value={item.value && /^#[0-9a-f]{6}$/i.test(item.value) ? item.value : "#000000"}
            onChange={(event) => choose(event.target.value)}
          />
          <span>More colours…</span>
        </label>
      </Popover>
    </span>
  );
}

/** Inline row of style swatches plus a popover with every option. */
export function RibbonGalleryControl({ item }: { item: RibbonGalleryItem }) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const visible = Math.max(1, item.visible ?? 4);
  const inline = item.options.slice(0, visible);
  const moreLabel = `More ${item.label.toLowerCase()}`;
  const option = (entry: RibbonGalleryItem["options"][number], inPopover: boolean) => (
    <button
      key={entry.id}
      type="button"
      className={cx("oui-ribbon__swatch", item.value === entry.id && "is-pressed")}
      aria-label={entry.label}
      title={entry.label}
      aria-pressed={item.value === entry.id}
      disabled={item.disabled}
      onClick={() => {
        if (inPopover) setOpen(false);
        item.onSelect(entry.id);
      }}
    >
      {entry.preview ?? <span className="oui-ribbon__swatch-text" style={entry.style}>{entry.label}</span>}
    </button>
  );
  return (
    <div className="oui-ribbon__gallery" role="group" aria-label={item.label}>
      {inline.map((entry) => option(entry, false))}
      {item.options.length > visible && (
        <button
          ref={moreRef}
          type="button"
          className="oui-ribbon__button oui-ribbon__gallery-more"
          aria-label={moreLabel}
          title={moreLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={item.disabled}
          onClick={() => setOpen((value) => !value)}
        >
          <Chevron />
        </button>
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={moreRef} label={item.label} className="oui-ribbon__gallery-popover">
        <div className="oui-ribbon__gallery-grid" onKeyDown={onGridKeyDown}>
          {item.options.map((entry) => option(entry, true))}
        </div>
      </Popover>
    </div>
  );
}
