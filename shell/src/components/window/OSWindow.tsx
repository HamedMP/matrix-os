"use client";

import { forwardRef, type ComponentProps, type CSSProperties, type PointerEventHandler } from "react";

import type { AppWindow } from "@/hooks/useWindowManager";
import { useWindowManager } from "@/hooks/useWindowManager";
import { cn } from "@/lib/utils";
import { DesignCaptionButtons } from "./DesignCaptionButtons";
import {
  MacGlassTitleBarChrome,
  MacTitleBarChrome,
  Win11TitleBarChrome,
  Win98TitleBarChrome,
  WinXpTitleBarChrome,
} from "./DesignTitleBarChrome";
import { TrafficLights } from "./TrafficLights";
import { designTitleBarContainerStyle, resolveTitleBarVariant, usesCaptionButtons } from "./title-bar-variant";
import { useThemeStyle } from "./useThemeStyle";

/**
 * The common DOM root for every app opened in the OS view. Surface renderers
 * supply placement, transitions, drag and resize behavior; this component
 * provides a stable window identity for shared chrome and app integrations.
 */
export const OSWindow = forwardRef<HTMLDivElement, ComponentProps<"div"> & { window: AppWindow }>(function OSWindow(
  { window, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-os-window
      data-window-id={window.id}
      className={className}
      {...props}
    />
  );
});

type TopBarPresentation = "desktop" | "canvas" | "fullscreen";

/**
 * Canonical lifecycle contract for an app opened by the OS view. Built-in apps
 * may use this hook for app-specific affordances without receiving renderer
 * callbacks through their props.
 */
export function useOSWindowControls(windowId: string) {
  const closeWindow = useWindowManager((state) => state.closeWindow);
  const minimizeWindow = useWindowManager((state) => state.minimizeWindow);
  const toggleFullscreen = useWindowManager((state) => state.toggleFullscreen);
  return {
    close: () => closeWindow(windowId),
    minimize: () => minimizeWindow(windowId),
    toggleFullscreen: () => toggleFullscreen(windowId),
  };
}

interface OSWindowTopBarProps {
  window: AppWindow;
  iconUrl?: string;
  isFocused?: boolean;
  presentation: TopBarPresentation;
  /** Lets Canvas preserve its dock animation before committing minimize. */
  onMinimize?: () => void;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shared OS-view title bar. Its controls deliberately call the window manager
 * directly so all built-in and iframe apps receive identical close, minimize,
 * and fullscreen semantics. A renderer may only override minimize to play a
 * surface-specific animation before committing the shared state transition.
 */
export function OSWindowTopBar({
  window,
  iconUrl,
  isFocused = true,
  presentation,
  onMinimize,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  className,
  style,
}: OSWindowTopBarProps) {
  const controls = useOSWindowControls(window.id);
  const titleBarVariant = resolveTitleBarVariant(useThemeStyle());
  const minimize = onMinimize ?? controls.minimize;
  const fullscreen = controls.toggleFullscreen;
  const close = controls.close;

  const handleDoubleClick: PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.target instanceof Element && event.target.closest("button,[role='button'],input,a")) return;
    fullscreen();
  };

  if (presentation === "canvas") {
    const designChromeProps = {
      title: window.title,
      iconUrl,
      isFocused,
      onClose: close,
      onMinimize: minimize,
      onMaximize: fullscreen,
    };
    const chrome = (() => {
      switch (titleBarVariant) {
        case "win98": return <Win98TitleBarChrome {...designChromeProps} />;
        case "macos-glass": return <MacGlassTitleBarChrome {...designChromeProps} />;
        case "winxp": return <WinXpTitleBarChrome {...designChromeProps} />;
        case "win11": return <Win11TitleBarChrome {...designChromeProps} />;
        default: return <MacTitleBarChrome {...designChromeProps} />;
      }
    })();
    return (
      <div
        data-os-window-top-bar="canvas"
        className={className}
        style={style}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={handleDoubleClick}
      >
        {chrome}
      </div>
    );
  }

  if (presentation === "fullscreen") {
    return (
      <div
        data-os-window-top-bar="fullscreen"
        className={cn("shrink-0 flex items-center gap-2 px-3 h-9 bg-muted/90 border-b border-border/60 select-none backdrop-blur-xl", className)}
        style={style}
        onDoubleClick={handleDoubleClick}
      >
        <TrafficLights onClose={close} onMinimize={minimize} onFullscreen={fullscreen} />
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0">
          {iconUrl ? (
            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon is served by the user runtime gateway and may change at runtime.
            <img src={iconUrl} alt="" className="size-4 rounded-md object-cover shrink-0" draggable={false} />
          ) : (
            <span className="size-4 rounded-md bg-muted flex items-center justify-center text-[9px] font-semibold text-muted-foreground shrink-0">
              {window.title.charAt(0).toUpperCase()}
            </span>
          )}
          <span className="text-xs font-medium text-foreground/70 truncate">{window.title}</span>
        </div>
        <div className="w-[42px] shrink-0" aria-hidden />
      </div>
    );
  }

  const captionButtons = usesCaptionButtons(titleBarVariant);
  return (
    <div
      data-os-window-top-bar="desktop"
      className={cn("flex flex-row items-center gap-0 px-3 py-2 md:cursor-grab md:active:cursor-grabbing select-none space-y-0", className)}
      style={{ ...designTitleBarContainerStyle(titleBarVariant), ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={handleDoubleClick}
    >
      {captionButtons ? (
        <>
          <span
            className={cn("text-xs truncate flex-1", titleBarVariant === "winxp" ? "font-bold text-white" : "font-medium text-foreground/70")}
            style={titleBarVariant === "winxp" ? { fontFamily: 'Tahoma, "Segoe UI", sans-serif', textShadow: "0 1px 2px rgba(0, 0, 0, 0.5)" } : undefined}
          >
            {window.title}
          </span>
          <DesignCaptionButtons variant={titleBarVariant} onClose={close} onMinimize={minimize} onMaximize={fullscreen} />
        </>
      ) : (
        <>
          <TrafficLights onClose={close} onMinimize={minimize} onFullscreen={fullscreen} />
          <span className="text-xs font-medium truncate flex-1 text-center">{window.title}</span>
          <div className="w-[78px]" aria-hidden />
        </>
      )}
    </div>
  );
}

/** The concise composition name for app window title bars. */
export const TopBar = OSWindowTopBar;
