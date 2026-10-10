"use client";

import { useEffect, useRef, useState } from "react";
import { iconUrlForSlug } from "@/lib/app-launch";

export function MobileAppIcon({ slug, iconUrl, size }: { slug: string; iconUrl?: string; size: number }) {
  const [src, setSrc] = useState(() => iconUrl ?? iconUrlForSlug(slug) ?? "/icon-192.png");
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
        borderRadius: Math.round(size * 0.22),
        background: "transparent",
        objectFit: "contain",
      }}
      onError={() => {
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

