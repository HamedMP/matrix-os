"use client";

import type { CSSProperties } from "react";

// The Matrix wordmark/glyph rendered as a CSS mask over a forest→gold shimmer,
// matching the onboarding hero. Shared by the boot/billing screens so every
// "loading / booting your computer" state shows the same branded mark instead
// of a generic lucide icon. Self-contained keyframe so it works on any route.
const SHIMMER =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 24%, #C4A265 50%, #2F392C 76%, #2F392C 100%)";

export function MatrixBootMark({
  size = 72,
  className = "",
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <>
      <style>{
        "@keyframes matrix-boot-shimmer{0%,100%{background-position:0% 0}50%{background-position:100% 0}}"
      }</style>
      <div
        data-matrix-boot-mark="true"
        // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- not a plain <img>: the logo is a CSS mask of the SVG over an animated shimmer gradient, which an <img> cannot reproduce
        role="img"
        aria-label="Matrix OS"
        className={className}
        style={{
          width: size,
          height: size,
          WebkitMask: "url('/matrix-logo.svg') no-repeat center / contain",
          mask: "url('/matrix-logo.svg') no-repeat center / contain",
          background: `${SHIMMER} 0 0 / 300% 100%`,
          animation: "matrix-boot-shimmer 7s ease-in-out infinite",
          ...style,
        }}
      />
    </>
  );
}
