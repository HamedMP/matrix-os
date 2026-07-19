"use client";

import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { Win11Logo, XpFlagLogo } from "../taskbar/taskbar-shared";
import { isBootDesign, type OsBootDesign } from "./os-session-utils";

const BOOT_LABEL: Record<OsBootDesign, string> = {
  "macos-glass": "macOS boot screen",
  winxp: "Windows XP boot screen",
  win11: "Windows 11 boot screen",
};

/**
 * White Apple-style glyph for the macOS boot screen. Mirrors MenuBar's
 * AppleLogoIcon but renders in its own fill so the boot screen stays white on
 * black regardless of menu-bar theming.
 */
function AppleBootLogo() {
  return (
    <svg viewBox="0 0 24 24" width={76} height={76} fill="#f5f5f7" aria-hidden="true" focusable="false">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.702" />
    </svg>
  );
}

/**
 * OS-authentic boot screen for the macos-glass / winxp / win11 designs: black
 * full-screen overlay with the platform logo and its classic progress idiom
 * (thin filling bar on macOS, three sliding blocks on XP, a spinning-dots ring
 * on Win11). Renders nothing for flat/neumorphic, which keep the shell's
 * existing loading surface. All animation lives in os-session.css and is
 * disabled under prefers-reduced-motion (a brief static flash remains).
 */
export function OsBootScreen({ design }: { design: string }) {
  if (!isBootDesign(design)) return null;
  return (
    <div
      data-os-boot={design}
      role="status"
      aria-label={BOOT_LABEL[design]}
      className="os-boot-screen"
      style={{ zIndex: SHELL_Z_INDEX.bootScreen }}
    >
      {design === "macos-glass" ? (
        <>
          <AppleBootLogo />
          <div className="os-boot-macos-bar" data-macos-boot-bar>
            <div className="os-boot-macos-fill" />
          </div>
        </>
      ) : null}
      {design === "winxp" ? (
        <>
          <div className="os-boot-xp-logo">
            <XpFlagLogo size={56} />
            <span className="os-boot-xp-wordmark">
              <span className="os-boot-xp-microsoft">Microsoft</span>
              <span className="os-boot-xp-windows">
                Windows<span className="os-boot-xp-edition">XP</span>
              </span>
            </span>
          </div>
          <div className="os-boot-xp-track" data-xp-boot-blocks>
            <div className="os-boot-xp-blocks" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </div>
        </>
      ) : null}
      {design === "win11" ? (
        <>
          <Win11Logo size={64} />
          <div className="os-boot-win11-spinner" data-win11-boot-spinner aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </>
      ) : null}
    </div>
  );
}
