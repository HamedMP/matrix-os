"use client";

import { useEffect, useRef, useState } from "react";
import { iconUrlForSlug } from "@/lib/app-launch";

/**
 * `fallbackName` opts out of the Matrix-logo fallback: when the icon cannot load, the tile shows the
 * name's initial instead, matching the Web Desktop and Electron Desktop launchers. Shared apps use it
 * because their owner icon comes from an extensionless platform route the `.svg` retry cannot repair.
 */
export function MobileAppIcon({ slug, iconUrl, size, fallbackName }: {
  slug: string; iconUrl?: string; size: number; fallbackName?: string;
}) {
  const [src, setSrc] = useState(() => iconUrl ?? iconUrlForSlug(slug) ?? "/icon-192.png");
  // Keyed by the URL that failed, so a new selection retries without a reset in the effect below.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const triedSvg = useRef(false);
  const selection = iconUrl ?? slug;
  const prevSelection = useRef(selection);

  useEffect(() => {
    if (prevSelection.current === selection) return;
    prevSelection.current = selection;
    triedSvg.current = false;
    // react-doctor-disable-next-line react-doctor/no-derived-state -- `src` is not pure derived state: it is seeded from the selected URL or `slug` but then mutated at runtime by the onError fallback chain (.png -> .svg -> /icon-192.png). Computing it in render would discard the resolved fallback and re-trigger the broken-image flicker on every render. This effect resets the chain only when the selected URL or slug changes.
    setSrc(iconUrl ?? iconUrlForSlug(slug) ?? "/icon-192.png");
  }, [slug, iconUrl, selection]);

  const radius = Math.round(size * 0.22);
  if (fallbackName && failedSrc === src) {
    return (
      <span
        data-testid="mobile-app-icon-initial"
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(size * 0.4),
          fontWeight: 600,
          background: "var(--accent-muted)",
          color: "var(--accent-text)",
        }}
      >
        {fallbackName.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- icon src is swapped at runtime via onError fallback chain (.png -> .svg -> /icon-192.png), which next/image does not support; <img> preserves the graceful-degradation behavior.
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: "transparent",
        objectFit: "contain",
      }}
      onError={() => {
        if (fallbackName) {
          setFailedSrc(src);
          return;
        }
        const svgUrl = src.replace(/\.[^.]+$/, ".svg");
        if (!triedSvg.current && src !== svgUrl) {
          triedSvg.current = true;
          setSrc(svgUrl);
        } else {
          setSrc("/icon-192.png");
        }
      }}
    />
  );
}

