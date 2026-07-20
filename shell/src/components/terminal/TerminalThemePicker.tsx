import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon, SquareTerminalIcon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { MATRIX_OS_APP_THEME_OPTIONS } from "@/lib/theme-presets";
import { useTerminalSettings, type ShellThemeId, type TerminalAppThemeId, type TerminalThemeId } from "@/stores/terminal-settings";
import type { TerminalAppThemeOption } from "./terminal-app-chrome-theme";

const PAPER_THEME_BUTTON_STYLE: CSSProperties = {
  alignItems: "center",
  background: "var(--terminal-drawer-button-bg)",
  borderColor: "var(--terminal-drawer-button-border)",
  borderRadius: 9,
  borderStyle: "solid",
  borderWidth: 1,
  color: "var(--terminal-drawer-button-fg)",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 600,
  gap: 8,
  height: 34,
  justifyContent: "center",
  padding: "0 12px",
};

const TERMINAL_THEME_MOBILE_DIALOG_STYLE: CSSProperties = {
  alignItems: "flex-end",
  background: "rgba(2, 5, 2, 0.42)",
  border: 0,
  display: "flex",
  height: "100dvh",
  inset: 0,
  justifyContent: "center",
  margin: 0,
  maxHeight: "none",
  maxWidth: "none",
  overflow: "hidden",
  padding: 0,
  position: "fixed",
  width: "100vw",
  zIndex: 94,
};

const TERMINAL_THEME_MOBILE_SHEET_STYLE: CSSProperties = {
  background: "#FFFDF7",
  borderRadius: "26px 26px 0 0",
  boxShadow: "0 -18px 50px rgba(0, 0, 0, 0.44)",
  color: "#2A2E22",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "10px 20px 17px",
  position: "relative",
  width: "min(390px, 100%)",
  zIndex: 1,
};

const TERMINAL_THEME_DESKTOP_MENU_STYLE: CSSProperties = {
  background: "#20241C",
  border: "1px solid #2D3127",
  borderRadius: 14,
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.42)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 8,
  padding: 6,
  position: "absolute",
  right: 0,
  top: "100%",
  width: 280,
  zIndex: 90,
};

export type ThemeMenuPlacement = "below-end" | "above-start";

function getTerminalThemeDesktopMenuPositionStyle(placement: ThemeMenuPlacement): CSSProperties {
  if (placement === "above-start") {
    return {
      bottom: "100%",
      left: 0,
      marginBottom: 8,
      marginTop: 0,
      right: "auto",
      top: "auto",
    };
  }

  return {};
}

const TERMINAL_THEME_MENU_DISMISS_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  cursor: "default",
  inset: 0,
  padding: 0,
  position: "absolute",
};

const TERMINAL_THEME_MOTION_CSS = `
@keyframes terminalThemePanelOpen {
  0% {
    opacity: 0;
    transform: translate3d(0, -8px, 0) scale(0.975);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalThemeMobilePanelOpen {
  0% {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalThemePanelForward {
  0% {
    opacity: 0;
    transform: translate3d(12px, 0, 0) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalThemePanelBack {
  0% {
    opacity: 0;
    transform: translate3d(-12px, 0, 0) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalShellThemeRowIn {
  0% {
    opacity: 0;
    transform: translate3d(0, 6px, 0);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0);
  }
}

@keyframes terminalShellThemeBadgeIn {
  0% {
    opacity: 0;
    transform: translate3d(8px, 0, 0) scale(0.9);
  }
  68% {
    opacity: 1;
    transform: translate3d(-1px, 0, 0) scale(1.04);
  }
  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
  }
}

@keyframes terminalShellThemeCheckIn {
  0% {
    opacity: 0;
    transform: scale(0.72);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-terminal-theme-motion],
  [data-terminal-shell-theme-motion] {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
`;

type TerminalThemeMotionDirection = "open" | "forward" | "back";

const TERMINAL_SHELL_THEME_DESKTOP_PANEL_STYLE: CSSProperties = {
  ...TERMINAL_THEME_DESKTOP_MENU_STYLE,
  background: "var(--terminal-chrome-bg)",
  border: "1px solid var(--terminal-chrome-control-border)",
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.44)",
  gap: 8,
  maxWidth: "calc(100vw - 24px)",
  padding: 8,
  width: 280,
};

const TERMINAL_SHELL_THEME_DESKTOP_HEADER_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 8,
  padding: "1px 1px 0",
};

const TERMINAL_SHELL_THEME_MOBILE_HEADER_STYLE: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 12,
};

const TERMINAL_THEME_MENU_ITEM_TEXT_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: 1,
  minWidth: 0,
};

function getTerminalThemeMenuItemStyle(mobile: boolean, selected: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: selected ? (mobile ? "#F4F3E9" : "#2A2E22") : "transparent",
    border: mobile ? `1px solid ${selected ? "#E4E2D2" : "transparent"}` : 0,
    borderRadius: mobile ? 14 : 10,
    color: mobile ? "#2A2E22" : "#F0EFE5",
    cursor: "pointer",
    display: "flex",
    gap: mobile ? 14 : 12,
    minHeight: mobile ? 64 : 51,
    padding: mobile ? "12px 14px" : "8px 10px",
    textAlign: "left",
    width: "100%",
  };
}

function getTerminalThemePreviewStyle(option: TerminalAppThemeOption, mobile: boolean): CSSProperties {
  return {
    background: option.preview.background,
    border: `1px solid ${option.preview.border}`,
    borderRadius: mobile ? 9 : 8,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: mobile ? 5 : 4,
    height: mobile ? 38 : 32,
    justifyContent: "center",
    padding: mobile ? 9 : 7,
    width: mobile ? 48 : 40,
  };
}

function getChangeShellThemeMenuItemStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: mobile ? "#F4F3E9" : "transparent",
    border: mobile ? "1px solid #E4E2D2" : 0,
    borderRadius: mobile ? 14 : 10,
    cursor: "pointer",
    display: "flex",
    gap: mobile ? 14 : 12,
    minHeight: mobile ? 64 : 48,
    padding: mobile ? "12px 14px" : "8px 10px",
    textAlign: "left",
    width: "100%",
  };
}

function getChangeShellThemeIconStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: mobile ? "#15180F" : "#171A13",
    border: mobile ? 0 : "1px solid #2D3127",
    borderRadius: mobile ? 10 : 8,
    color: mobile ? "#9CB77A" : "#6F7167",
    display: "flex",
    flexShrink: 0,
    height: mobile ? 38 : 32,
    justifyContent: "center",
    width: mobile ? 38 : 40,
  };
}

const SHELL_THEME_OPTIONS: Array<{
  id: ShellThemeId;
  label: string;
  badge: "RECOMMENDED" | "NOT FULLY TUNED";
  badgeTone: "recommended" | "warning";
  description: string;
  preview: {
    background: string;
    border: string;
    line: string;
    dotA: string;
    dotB: string;
  };
}> = [
  {
    id: "dark",
    label: "Dark",
    badge: "RECOMMENDED",
    badgeTone: "recommended",
    description: "Zellij default · best contrast",
    preview: {
      background: "#0C0C0C",
      border: "#15180F",
      line: "#0AD18B",
      dotA: "#2BD9D9",
      dotB: "#F1FA5C",
    },
  },
  {
    id: "light",
    label: "Light",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "gruvbox-light",
    preview: {
      background: "#FBF1C7",
      border: "#E4D9B0",
      line: "#3C3836",
      dotA: "#79740E",
      dotB: "#CC241D",
    },
  },
  {
    id: "matrix",
    label: "Matrix",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "custom · green on black",
    preview: {
      background: "#020A02",
      border: "#0E5A26",
      line: "#39FF6A",
      dotA: "#5BF08A",
      dotB: "#00CC44",
    },
  },
];

function mapTerminalThemeToShellTheme(themeId: TerminalThemeId | undefined): ShellThemeId {
  if (themeId === "dark" || themeId === "light" || themeId === "matrix") {
    return themeId;
  }
  if (themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light") {
    return "light";
  }
  return "dark";
}

export function ThemePickerButton({ mobile, menuPlacement = "below-end" }: { mobile: boolean; menuPlacement?: ThemeMenuPlacement }) {
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [themeMenuView, setThemeMenuView] = useState<"app" | "shell">("app");
  const [themeMenuMotion, setThemeMenuMotion] = useState<TerminalThemeMotionDirection>("open");
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeThemeMenu = () => {
    setThemeMenuOpen(false);
    setThemeMenuView("app");
    setThemeMenuMotion("open");
  };
  const closeThemeMenuEvent = useEffectEvent(closeThemeMenu);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) closeThemeMenuEvent();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeThemeMenuEvent();
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [themeMenuOpen]);

  const openThemeMenu = () => {
    if (themeMenuOpen) {
      closeThemeMenu();
      return;
    }
    setThemeMenuView("app");
    setThemeMenuMotion("open");
    setThemeMenuOpen(true);
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative" }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <style>{TERMINAL_THEME_MOTION_CSS}</style>
      <button
        type="button"
        aria-label="Theme"
        title="Theme"
        style={PAPER_THEME_BUTTON_STYLE}
        onClick={openThemeMenu}
      >
        <span style={{ color: "#CF7835", fontSize: 17, fontWeight: 600, lineHeight: "22px" }}>☼</span>
        <span>Theme</span>
      </button>
      {themeMenuOpen && themeMenuView === "app" ? (
        <TerminalAppThemeMenu
          mobile={mobile}
          placement={menuPlacement}
          motionDirection={themeMenuMotion}
          onClose={closeThemeMenu}
          onOpenShellTheme={() => {
            setThemeMenuMotion("forward");
            setThemeMenuView("shell");
          }}
        />
      ) : null}
      {themeMenuOpen && themeMenuView === "shell" ? (
        <ShellThemeChooser
          mobile={mobile}
          placement={menuPlacement}
          motionDirection={themeMenuMotion}
          onBack={() => {
            setThemeMenuMotion("back");
            setThemeMenuView("app");
          }}
          onClose={closeThemeMenu}
        />
      ) : null}
    </div>
  );
}

function TerminalAppThemeMenu({
  mobile,
  placement,
  motionDirection,
  onClose,
  onOpenShellTheme,
}: {
  mobile: boolean;
  placement: ThemeMenuPlacement;
  motionDirection: TerminalThemeMotionDirection;
  onClose: () => void;
  onOpenShellTheme: () => void;
}) {
  const appThemeId = useTerminalSettings((s) => s.appThemeId);
  const setAppThemeId = useTerminalSettings((s) => s.setAppThemeId);

  const chooseAppTheme = (next: TerminalAppThemeId) => {
    setAppThemeId(next);
    onClose();
  };

  if (mobile) {
    return (
      <dialog
        aria-label="Theme"
        aria-modal="true"
        open
        style={TERMINAL_THEME_MOBILE_DIALOG_STYLE}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <button
          type="button"
          aria-label="Dismiss theme menu"
          tabIndex={-1}
          onClick={onClose}
          style={TERMINAL_THEME_MENU_DISMISS_STYLE}
        />
        <div
          role="menu"
          aria-label="Theme"
          data-terminal-theme-motion={motionDirection}
          data-testid="terminal-app-theme-panel"
          style={{
            ...TERMINAL_THEME_MOBILE_SHEET_STYLE,
            ...getTerminalThemePanelMotionStyle(true, motionDirection),
          }}
        >
          <div style={{ alignItems: "center", display: "flex", justifyContent: "center", paddingBottom: 4 }}>
            <div style={{ background: "#D6D5C4", borderRadius: 999, height: 5, width: 42 }} />
          </div>
          <div style={{ color: "#2A2E22", fontFamily: "Inter, system-ui, sans-serif", fontSize: 19, fontWeight: 700, lineHeight: "24px" }}>
            Theme
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {MATRIX_OS_APP_THEME_OPTIONS.map((option) => (
              <TerminalAppThemeMenuItem
                key={option.id}
                mobile
                option={option}
                selected={option.id === appThemeId}
                onClick={() => chooseAppTheme(option.id)}
              />
            ))}
          </div>
          <div style={{ background: "#E4E2D2", height: 1 }} />
          <ChangeShellThemeMenuItem mobile onClick={onOpenShellTheme} />
          <div style={{ alignItems: "center", display: "flex", justifyContent: "center", paddingBottom: 9, paddingTop: 8 }}>
            <div style={{ background: "#1F221B", borderRadius: 999, height: 5, width: 140 }} />
          </div>
        </div>
      </dialog>
    );
  }

  return (
    <div
      role="menu"
      aria-label="Theme"
      data-terminal-theme-motion={motionDirection}
      data-testid="terminal-app-theme-panel"
      style={{
        ...TERMINAL_THEME_DESKTOP_MENU_STYLE,
        ...getTerminalThemeDesktopMenuPositionStyle(placement),
        ...getTerminalThemePanelMotionStyle(false, motionDirection),
      }}
    >
      <div style={{ padding: "8px 10px 4px" }}>
        <div style={{ color: "#6F7167", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", lineHeight: "15px", textTransform: "uppercase" }}>
          Theme
        </div>
      </div>
      {MATRIX_OS_APP_THEME_OPTIONS.map((option) => (
        <TerminalAppThemeMenuItem
          key={option.id}
          option={option}
          selected={option.id === appThemeId}
          onClick={() => chooseAppTheme(option.id)}
        />
      ))}
      <div style={{ background: "#2A2E22", height: 1, margin: "4px 8px" }} />
      <ChangeShellThemeMenuItem onClick={onOpenShellTheme} />
    </div>
  );
}

function TerminalAppThemeMenuItem({
  mobile = false,
  option,
  selected,
  onClick,
}: {
  mobile?: boolean;
  option: TerminalAppThemeOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      aria-label={`${option.label} ${option.description}`}
      onClick={onClick}
      style={getTerminalThemeMenuItemStyle(mobile, selected)}
    >
      <TerminalAppThemePreview option={option} mobile={mobile} />
      <span style={TERMINAL_THEME_MENU_ITEM_TEXT_STYLE}>
        <span style={{ color: mobile ? "#2A2E22" : "#F0EFE5", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 16 : 14, fontWeight: 600, lineHeight: mobile ? "20px" : "18px" }}>
          {option.label}
        </span>
        <span style={{ color: "#858578", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 13 : 12, lineHeight: "16px" }}>
          {option.description}
        </span>
      </span>
      {selected ? <CheckIcon size={mobile ? 20 : 18} strokeWidth={2.4} style={{ color: mobile ? "#4F8A55" : "#9CB77A", flexShrink: 0 }} /> : null}
    </button>
  );
}

function TerminalAppThemePreview({
  option,
  mobile,
}: {
  option: TerminalAppThemeOption;
  mobile: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={getTerminalThemePreviewStyle(option, mobile)}
    >
      <span style={{ background: option.preview.stripe, borderRadius: 2, display: "block", height: 3, width: mobile ? 22 : 18 }} />
      <span style={{ display: "flex", gap: mobile ? 4 : 3 }}>
        <span style={{ background: option.preview.dotA, borderRadius: 999, display: "block", height: mobile ? 7 : 6, width: mobile ? 7 : 6 }} />
        <span style={{ background: option.preview.dotB, borderRadius: 999, display: "block", height: mobile ? 7 : 6, width: mobile ? 7 : 6 }} />
      </span>
    </span>
  );
}

function ChangeShellThemeMenuItem({
  mobile = false,
  onClick,
}: {
  mobile?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label="Change shell theme Advanced terminal colors"
      onClick={onClick}
      style={getChangeShellThemeMenuItemStyle(mobile)}
    >
      <span
        aria-hidden="true"
        style={getChangeShellThemeIconStyle(mobile)}
      >
        <SquareTerminalIcon size={mobile ? 18 : 16} strokeWidth={2} />
      </span>
      <span style={TERMINAL_THEME_MENU_ITEM_TEXT_STYLE}>
        <span style={{ color: mobile ? "#5F6258" : "#858578", fontFamily: "Inter, system-ui, sans-serif", fontSize: mobile ? 15 : 13, fontWeight: 600, lineHeight: mobile ? "18px" : "16px" }}>
          Change shell theme
        </span>
        <span style={{ color: mobile ? "#A09F92" : "#5F6258", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, lineHeight: mobile ? "16px" : "15px" }}>
          Advanced · terminal colors
        </span>
      </span>
      <ChevronRightIcon size={mobile ? 18 : 16} strokeWidth={2} style={{ color: mobile ? "#A09F92" : "#5F6258", flexShrink: 0 }} />
    </button>
  );
}

function ShellThemeChooser({
  mobile,
  placement,
  motionDirection,
  onBack,
  onClose,
}: {
  mobile: boolean;
  placement: ThemeMenuPlacement;
  motionDirection: TerminalThemeMotionDirection;
  onBack: () => void;
  onClose: () => void;
}) {
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const selectedShellThemeId = mapTerminalThemeToShellTheme(themeId);

  const persistShellTheme = (next: ShellThemeId) => {
    setThemeId(next);
    if (typeof fetch !== "function") {
      return;
    }
    const state = useTerminalSettings.getState();
    void fetch(`${getGatewayUrl()}/api/terminal/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shellThemeId: next,
        fontFamily: state.fontFamily,
        ligatures: state.ligatures,
        cursorStyle: state.cursorStyle,
        smoothScroll: state.smoothScroll,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save shell theme preferences:", err instanceof Error ? err.message : err);
    });
  };

  const content = (
    <ShellThemeChooserContent
      mobile={mobile}
      onBack={onBack}
      onSelectTheme={persistShellTheme}
      selectedShellThemeId={selectedShellThemeId}
    />
  );

  if (mobile) {
    return (
      <dialog
        aria-label="Theme"
        aria-modal="true"
        open
        style={TERMINAL_THEME_MOBILE_DIALOG_STYLE}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <button
          type="button"
          aria-label="Dismiss theme menu"
          tabIndex={-1}
          onClick={onClose}
          style={TERMINAL_THEME_MENU_DISMISS_STYLE}
        />
        <section
          aria-label="Shell theme"
          data-terminal-theme-motion={motionDirection}
          data-terminal-shell-theme-motion
          data-testid="terminal-shell-theme-panel"
          style={{
            ...TERMINAL_THEME_MOBILE_SHEET_STYLE,
            ...getTerminalThemePanelMotionStyle(true, motionDirection),
          }}
        >
          {content}
        </section>
      </dialog>
    );
  }

  return (
    <>
      <section
        aria-label="Shell theme"
        data-terminal-theme-motion={motionDirection}
        data-terminal-shell-theme-motion
        data-testid="terminal-shell-theme-panel"
        style={{
          ...TERMINAL_SHELL_THEME_DESKTOP_PANEL_STYLE,
          ...getTerminalThemeDesktopMenuPositionStyle(placement),
          ...getTerminalThemePanelMotionStyle(false, motionDirection),
        }}
      >
        {content}
      </section>
    </>
  );
}

function ShellThemeChooserContent({
  mobile,
  onBack,
  onSelectTheme,
  selectedShellThemeId,
}: {
  mobile: boolean;
  onBack: () => void;
  onSelectTheme: (next: ShellThemeId) => void;
  selectedShellThemeId: ShellThemeId;
}) {
  return (
    <>
      {mobile ? (
        <div style={{ alignSelf: "center", background: "#D4D4C4", borderRadius: 999, height: 5, width: 42 }} />
      ) : null}
      <div style={mobile ? TERMINAL_SHELL_THEME_MOBILE_HEADER_STYLE : TERMINAL_SHELL_THEME_DESKTOP_HEADER_STYLE}>
        <button
          type="button"
          aria-label="Back to theme menu"
          onClick={onBack}
          style={{
            alignItems: "center",
            background: mobile ? "#F4F3E9" : "var(--terminal-chrome-control-bg)",
            border: `1px solid ${mobile ? "#E4E2D2" : "var(--terminal-chrome-control-border)"}`,
            borderRadius: mobile ? 10 : 8,
            color: mobile ? "#5F6258" : "var(--terminal-chrome-control-fg)",
            cursor: "pointer",
            display: "flex",
            flexShrink: 0,
            height: mobile ? 38 : 32,
            justifyContent: "center",
            width: mobile ? 38 : 32,
          }}
        >
          <ChevronLeftIcon size={mobile ? 19 : 17} strokeWidth={2.2} />
        </button>
        <ShellThemeHeaderIcon mobile={mobile} />
        <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ color: mobile ? "#20241C" : "var(--terminal-chrome-fg)", fontSize: mobile ? 17 : 14, fontWeight: 800, lineHeight: mobile ? "22px" : "18px" }}>
            Shell theme
          </span>
          <span style={{ color: mobile ? "#77786C" : "var(--terminal-chrome-muted)", fontSize: mobile ? 12 : 11, lineHeight: mobile ? "16px" : "14px" }}>
            {mobile
              ? "Terminal colors. We recommend Dark."
              : "Terminal colors. Dark reads best."}
          </span>
        </span>
      </div>

      <div role="radiogroup" aria-label="Shell theme options" style={{ display: "flex", flexDirection: "column", gap: mobile ? 9 : 7 }}>
        {SHELL_THEME_OPTIONS.map((option, index) => {
          const selected = option.id === selectedShellThemeId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${option.label} ${option.description}`}
              data-terminal-shell-theme-motion
              onClick={() => onSelectTheme(option.id)}
              style={{
                ...getShellThemeOptionStyle(mobile, selected),
                ...getShellThemeOptionMotionStyle(index),
              }}
            >
              <ShellThemePreviewIcon option={option} mobile={mobile} />
              <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: mobile ? "#20241C" : "var(--terminal-chrome-fg)", fontSize: mobile ? 14 : 13, fontWeight: 800, lineHeight: "18px" }}>
                  {option.label}
                </span>
                <span style={{ color: mobile ? "#77786C" : "var(--terminal-chrome-muted)", fontSize: mobile ? 11 : 10, lineHeight: mobile ? "15px" : "13px" }}>
                  {option.description}
                </span>
              </span>
              <span style={getShellThemeOptionTrailingStyle(mobile)}>
                <span data-terminal-shell-theme-motion style={getShellThemeBadgeStyle(option.badgeTone, mobile, index)}>
                  {option.badge}
                </span>
                {selected ? (
                  <span data-terminal-shell-theme-motion style={getShellThemeCheckStyle(mobile, index)}>
                    <CheckIcon
                      size={mobile ? 18 : 16}
                      strokeWidth={2.5}
                      style={{ color: mobile ? "#4F8A55" : "var(--terminal-chrome-active)", display: "block" }}
                    />
                  </span>
                ) : (
                  <span aria-hidden="true" style={{ flexShrink: 0, height: mobile ? 18 : 16, width: mobile ? 18 : 16 }} />
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div style={getShellThemeWarningStyle(mobile)}>
        <span aria-hidden="true" style={{ background: mobile ? "#D2B35F" : "#D2A23C", borderRadius: 999, flexShrink: 0, width: 3 }} />
        <span>
          {mobile
            ? "Light & Matrix aren't fully tuned — some colors lose contrast. Switch back to Dark if output looks off."
            : "Light and Matrix are not fully tuned; switch back to Dark if output looks off."}
        </span>
      </div>

      {mobile ? (
        <div style={{ alignItems: "center", display: "flex", height: 18, justifyContent: "center" }}>
          <div style={{ background: "#000000", borderRadius: 999, height: 5, width: 140 }} />
        </div>
      ) : null}
    </>
  );
}

function getTerminalThemePanelMotionStyle(
  mobile: boolean,
  direction: TerminalThemeMotionDirection,
): CSSProperties {
  const animationName = direction === "open"
    ? (mobile ? "terminalThemeMobilePanelOpen" : "terminalThemePanelOpen")
    : direction === "forward"
      ? "terminalThemePanelForward"
      : "terminalThemePanelBack";
  return {
    animation: `${animationName} 180ms cubic-bezier(0.16, 1, 0.3, 1) both`,
    transformOrigin: mobile ? "bottom center" : "top right",
  };
}

function getShellThemeOptionMotionStyle(index: number): CSSProperties {
  return {
    animation: `terminalShellThemeRowIn 220ms cubic-bezier(0.16, 1, 0.3, 1) ${45 + index * 35}ms both`,
  };
}

function getShellThemeOptionStyle(mobile: boolean, selected: boolean): CSSProperties {
  if (mobile) {
    return {
      alignItems: "center",
      background: selected ? "#F4F3E9" : "#FFFDF7",
      border: `1px solid ${selected ? "#D6D5C4" : "#E9E6D8"}`,
      borderRadius: 14,
      color: "#2F332C",
      cursor: "pointer",
      display: "flex",
      gap: 13,
      minHeight: 58,
      padding: "10px 12px",
      textAlign: "left",
      width: "100%",
    };
  }

  return {
    alignItems: "center",
    background: selected ? "rgba(57, 255, 106, 0.08)" : "rgba(255, 255, 255, 0.02)",
    border: `1px solid ${selected ? "var(--terminal-chrome-active)" : "var(--terminal-chrome-control-border)"}`,
    borderRadius: 9,
    color: "var(--terminal-chrome-fg)",
    cursor: "pointer",
    display: "flex",
    gap: 9,
    minHeight: 50,
    padding: "8px 9px",
    textAlign: "left",
    width: "100%",
  };
}

function getShellThemeOptionTrailingStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    gap: mobile ? 9 : 6,
    justifyContent: "flex-end",
    minWidth: mobile ? 116 : 86,
  };
}

function getShellThemeBadgeStyle(badgeTone: "recommended" | "warning", mobile: boolean, index: number): CSSProperties {
  const recommended = badgeTone === "recommended";
  return {
    animation: `terminalShellThemeBadgeIn 300ms cubic-bezier(0.19, 1, 0.22, 1) ${95 + index * 45}ms both`,
    background: recommended ? (mobile ? "#DDEBCE" : "rgba(156, 183, 122, 0.2)") : (mobile ? "#F4E4A8" : "rgba(210, 162, 60, 0.2)"),
    borderRadius: 6,
    color: recommended ? (mobile ? "#4F8A55" : "#A8D27C") : (mobile ? "#A06F1D" : "#E2BC62"),
    fontSize: mobile ? 9 : 8,
    fontWeight: 800,
    letterSpacing: "0.01em",
    lineHeight: mobile ? "14px" : "13px",
    padding: mobile ? "2px 7px" : "2px 6px",
    transformOrigin: "center right",
    whiteSpace: "nowrap",
  };
}

function getShellThemeCheckStyle(mobile: boolean, index: number): CSSProperties {
  return {
    alignItems: "center",
    animation: `terminalShellThemeCheckIn 180ms cubic-bezier(0.16, 1, 0.3, 1) ${145 + index * 45}ms both`,
    display: "flex",
    flexShrink: 0,
    height: mobile ? 18 : 16,
    justifyContent: "center",
    width: mobile ? 18 : 16,
  };
}

function getShellThemeWarningStyle(mobile: boolean): CSSProperties {
  return {
    background: mobile ? "#F7F1E2" : "rgba(210, 162, 60, 0.12)",
    border: `1px solid ${mobile ? "#ECE2C6" : "rgba(210, 162, 60, 0.28)"}`,
    borderRadius: mobile ? 9 : 10,
    color: mobile ? "#8A7B52" : "#D4B570",
    display: "flex",
    fontSize: mobile ? 10 : 10,
    gap: mobile ? 10 : 8,
    lineHeight: mobile ? "14px" : "14px",
    padding: mobile ? "10px 12px" : "9px 10px",
  };
}

function ShellThemeHeaderIcon({ mobile }: { mobile: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: "#050A06",
        border: "1px solid rgba(57, 255, 106, 0.48)",
        borderRadius: mobile ? 11 : 9,
        boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.05), 0 0 18px rgba(57, 255, 106, 0.14)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: mobile ? 5 : 4,
        height: mobile ? 40 : 34,
        justifyContent: "center",
        width: mobile ? 40 : 34,
      }}
    >
      <span style={{ background: "#39FF6A", borderRadius: 999, display: "block", height: 3, width: mobile ? 21 : 18 }} />
      <span style={{ display: "flex", gap: 4 }}>
        <span style={{ background: "#27E9A4", borderRadius: 999, display: "block", height: mobile ? 6 : 5, width: mobile ? 6 : 5 }} />
        <span style={{ background: "#E6E678", borderRadius: 999, display: "block", height: mobile ? 6 : 5, width: mobile ? 6 : 5 }} />
      </span>
    </span>
  );
}

function ShellThemePreviewIcon({
  option,
  mobile,
}: {
  option: (typeof SHELL_THEME_OPTIONS)[number];
  mobile: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: option.preview.background,
        border: `1px solid ${option.preview.border}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: mobile ? 5 : 4,
        height: mobile ? 32 : 28,
        justifyContent: "center",
        width: mobile ? 36 : 34,
      }}
    >
      <span style={{ background: option.preview.line, borderRadius: 2, display: "block", height: 3, width: mobile ? 16 : 15 }} />
      <span style={{ display: "flex", gap: 3 }}>
        <span style={{ background: option.preview.dotA, borderRadius: 999, display: "block", height: 5, width: 5 }} />
        <span style={{ background: option.preview.dotB, borderRadius: 999, display: "block", height: 5, width: 5 }} />
      </span>
    </span>
  );
}
