"use client";

import { TrafficLights } from "./TrafficLights";
import { WinXpCaptionButtons, Win11CaptionButtons } from "./DesignCaptionButtons";

/**
 * Floating title-bar chrome (the inner content of Canvas floating title bars)
 * for the design-system theme styles. The outer absolute positioning + drag
 * handling stays in CanvasWindow; these components only render the visual
 * bar, following the macTitleBar/win98TitleBar precedent: inline
 * `var(--...)` token styles + data attributes, no extra CSS.
 */

export interface DesignTitleBarChromeProps {
  title: string;
  iconUrl?: string;
  isFocused: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
}

function TitleIcon({ title, iconUrl }: { title: string; iconUrl?: string }) {
  return iconUrl ? (
    // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png with ?v=etag) that cannot be statically configured for next/image
    <img src={iconUrl} alt="" className="size-4 rounded-md object-cover shrink-0" draggable={false} />
  ) : (
    <span className="size-4 rounded-md bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
      {title.charAt(0).toUpperCase()}
    </span>
  );
}

/** macOS glass: frosted floating pill — heavy blur, specular top edge, soft shadow. */
export function MacGlassTitleBarChrome({
  title,
  iconUrl,
  isFocused,
  onClose,
  onMinimize,
  onMaximize,
}: DesignTitleBarChromeProps) {
  return (
    <div
      data-title-bar="macos-glass"
      className="relative w-full h-full flex items-center gap-2 px-3 overflow-hidden transition-all duration-200"
      style={{
        background: isFocused ? "var(--glass-surface-strong)" : "var(--glass-surface)",
        backdropFilter: "var(--glass-blur)",
        WebkitBackdropFilter: "var(--glass-blur)",
        border: "1px solid var(--glass-edge)",
        borderRadius: 18,
        boxShadow: "var(--glass-specular), var(--glass-shadow)",
        opacity: isFocused ? 1 : 0.85,
      }}
    >
      <TrafficLights
        className="mr-2 shrink-0 relative z-10"
        onClose={onClose}
        onMinimize={onMinimize}
        onFullscreen={onMaximize}
      />
      {/* Centered title with icon */}
      <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 relative z-10">
        <TitleIcon title={title} iconUrl={iconUrl} />
        <span className="text-xs font-medium text-foreground/70 truncate">
          {title}
        </span>
      </div>
      <div className="w-[42px] shrink-0" />
    </div>
  );
}

/** Windows XP: Luna blue gradient bar, white bold Tahoma title, beveled caption buttons. */
export function WinXpTitleBarChrome({
  title,
  iconUrl,
  isFocused,
  onClose,
  onMinimize,
  onMaximize,
}: DesignTitleBarChromeProps) {
  return (
    <div
      data-title-bar="winxp"
      className="relative w-full h-full flex items-center pl-2 pr-1 gap-2"
      style={{
        background: "var(--xp-titlebar)",
        border: "1px solid var(--xp-blue-dark)",
        borderRadius: "3px 3px 0 0",
        boxShadow:
          "inset 0 1px 0 rgba(255, 255, 255, 0.4), inset 1px 0 0 rgba(255, 255, 255, 0.25), 2px 2px 4px rgba(0, 0, 0, 0.3)",
        filter: isFocused ? undefined : "saturate(0.35)",
      }}
    >
      {/* Left: icon + title */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <TitleIcon title={title} iconUrl={iconUrl} />
        <span
          className="text-xs font-bold truncate text-white"
          style={{
            fontFamily: 'Tahoma, "Segoe UI", sans-serif',
            textShadow: "0 1px 2px rgba(0, 0, 0, 0.5)",
          }}
        >
          {title}
        </span>
      </div>
      {/* Right: XP caption buttons */}
      <WinXpCaptionButtons onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />
    </div>
  );
}

/** Windows 11: Fluent acrylic bar, subtle gray title, flat glyph caption buttons. */
export function Win11TitleBarChrome({
  title,
  iconUrl,
  isFocused,
  onClose,
  onMinimize,
  onMaximize,
}: DesignTitleBarChromeProps) {
  return (
    <div
      data-title-bar="win11"
      className="relative w-full h-full flex items-center pl-3 pr-1 gap-2"
      style={{
        background: "var(--win11-acrylic-strong)",
        backdropFilter: "var(--win11-blur)",
        WebkitBackdropFilter: "var(--win11-blur)",
        border: "1px solid var(--win11-stroke)",
        borderRadius: "8px 8px 0 0",
        boxShadow: "var(--win11-shadow)",
        opacity: isFocused ? 1 : 0.85,
      }}
    >
      {/* Left: icon + title */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <TitleIcon title={title} iconUrl={iconUrl} />
        <span className="text-xs font-medium text-foreground/60 truncate">
          {title}
        </span>
      </div>
      {/* Right: Win11 caption buttons */}
      <Win11CaptionButtons onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />
    </div>
  );
}
