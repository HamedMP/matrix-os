"use client";

/**
 * Windows XP-styled inline SVG glyphs for the winxp Explorer chrome.
 * Drawn in code (no network assets) so the Files app renders identically
 * offline, in tests, and inside any renderer.
 */

interface GlyphProps {
  size?: number;
  className?: string;
}

/** Classic XP yellow folder. */
export function XpFolderGlyph({ size = 48, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* tab + back panel */}
      <path
        d="M5 11c0-2.2 1.8-4 4-4h9.5c1.4 0 2.7.7 3.4 1.9l2 3.1H39c2.2 0 4 1.8 4 4v3H5v-8z"
        fill="#d9a826"
      />
      {/* front panel */}
      <path
        d="M5 16h38c1.1 0 2 .9 2 2v19c0 2.2-1.8 4-4 4H9c-2.2 0-4-1.8-4-4V16z"
        fill="#ffd968"
      />
      <path
        d="M5 16h38c1.1 0 2 .9 2 2v19c0 2.2-1.8 4-4 4H9c-2.2 0-4-1.8-4-4V16z"
        fill="none"
        stroke="#b8860b"
        strokeWidth="1.4"
      />
      {/* top highlight */}
      <path d="M7 18h34" stroke="#fff3c4" strokeWidth="2" />
    </svg>
  );
}

/** White page with folded corner and a small colored app mark. */
export function XpFileGlyph({ size = 48, color = "#7f9db9", className }: GlyphProps & { color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M11 4h18l10 10v28c0 1.1-.9 2-2 2H11c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" fill="#ffffff" />
      <path
        d="M11 4h18l10 10v28c0 1.1-.9 2-2 2H11c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"
        fill="none"
        stroke="#7f9db9"
        strokeWidth="1.4"
      />
      {/* folded corner */}
      <path d="M29 4l10 10H31c-1.1 0-2-.9-2-2V4z" fill="#dbe7f3" stroke="#7f9db9" strokeWidth="1.2" />
      {/* colored app mark */}
      <rect x="15" y="20" width="18" height="14" rx="1.5" fill={color} />
      <path d="M18 24h12M18 27.5h12M18 31h8" stroke="#ffffff" strokeWidth="1.6" />
    </svg>
  );
}

/** Green round navigation arrow (Back / Forward / Go). */
export function XpRoundArrowGlyph({
  size = 22,
  direction = "left",
  className,
}: GlyphProps & { direction?: "left" | "right" | "up" }) {
  const arrow =
    direction === "left"
      ? "M26 15l-9 9 9 9M18 24h14"
      : direction === "right"
        ? "M22 15l9 9-9 9M16 24h14"
        : "M15 26l9-9 9 9M24 18v14";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="24" cy="24" r="19" fill="#3aa743" stroke="#1f6b26" strokeWidth="2" />
      <circle cx="24" cy="21" r="15" fill="#5cc465" opacity="0.55" />
      <path d={arrow} fill="none" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Folder with an up arrow (Up one level). */
export function XpUpGlyph({ size = 22, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 14c0-1.7 1.3-3 3-3h8l2.5 3.5H33c1.7 0 3 1.3 3 3v2H6v-5.5z" fill="#d9a826" />
      <path
        d="M6 19h30c.8 0 1.5.7 1.5 1.5V33c0 1.7-1.3 3-3 3H9c-1.7 0-3-1.3-3-3V19z"
        fill="#ffd968"
        stroke="#b8860b"
        strokeWidth="1.3"
      />
      <circle cx="33" cy="32" r="11" fill="#3aa743" stroke="#1f6b26" strokeWidth="1.6" />
      <path
        d="M33 26v10M28.5 30.5L33 26l4.5 4.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Magnifier (Search companion). */
export function XpSearchGlyph({ size = 22, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="21" cy="21" r="12" fill="#bfe0f5" stroke="#33689c" strokeWidth="2.5" />
      <circle cx="21" cy="21" r="7" fill="#e8f4fd" />
      <path d="M30 30l11 11" stroke="#8a6d3b" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

/** Four-pane views grid. */
export function XpViewsGlyph({ size = 22, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="8" y="8" width="14" height="14" rx="2" fill="#3a93ff" stroke="#1f5cb0" strokeWidth="1.5" />
      <rect x="26" y="8" width="14" height="14" rx="2" fill="#ffffff" stroke="#7f9db9" strokeWidth="1.5" />
      <rect x="8" y="26" width="14" height="14" rx="2" fill="#ffffff" stroke="#7f9db9" strokeWidth="1.5" />
      <rect x="26" y="26" width="14" height="14" rx="2" fill="#ffffff" stroke="#7f9db9" strokeWidth="1.5" />
    </svg>
  );
}

/** Small chevron used on combo boxes, tool buttons and pane headers. */
export function XpChevronGlyph({
  size = 10,
  direction = "down",
  className,
}: GlyphProps & { direction?: "up" | "down" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={direction === "up" ? { transform: "rotate(180deg)" } : undefined}
    >
      <path d="M1.5 3l3.5 4 3.5-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** CRT monitor glyph for Other Places "home" entries. */
export function XpComputerGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="6" y="8" width="36" height="26" rx="2.5" fill="#e8e8e8" stroke="#716f64" strokeWidth="1.6" />
      <rect x="10" y="12" width="28" height="18" fill="#3a93ff" />
      <path d="M18 38h12M24 34v4" stroke="#716f64" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Recycle Bin: gray mesh bin with crumpled paper (desktop icon). */
export function XpRecycleBinGlyph({ size = 32, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* crumpled paper sticking out of the bin */}
      <path d="M17 5l7 2-1.5 6-6.5-1.5L17 5z" fill="#ffffff" stroke="#8f8f8f" strokeWidth="1" />
      <path d="M27 3.5l6 4.5-3 4.5-4.5-3.5L27 3.5z" fill="#f2f2f2" stroke="#8f8f8f" strokeWidth="1" />
      {/* rim */}
      <rect x="9" y="11" width="30" height="5" rx="1.6" fill="#ece9e1" stroke="#7a7a7a" strokeWidth="1.4" />
      {/* bin body */}
      <path
        d="M11.5 17h25l-2.3 23.5c-.15 1.5-1.4 2.6-2.9 2.6H16.7c-1.5 0-2.75-1.1-2.9-2.6L11.5 17z"
        fill="#d4d0c8"
        stroke="#7a7a7a"
        strokeWidth="1.4"
      />
      {/* mesh ribs */}
      <path
        d="M17 20l1.2 18M24 20v18M31 20l-1.2 18M13 24h22M13.6 30h20.8M14.4 36h19.2"
        stroke="#a39e94"
        strokeWidth="1.1"
      />
    </svg>
  );
}
