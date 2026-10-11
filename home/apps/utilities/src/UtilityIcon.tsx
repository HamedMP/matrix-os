import React from "react";
import { toolIconSvg } from "./vendor/lib/tool-icons.mjs";

/** Artwork comes from the pinned website registry, never user-provided markup. */
export function UtilityIcon({ slug, small = false }: { slug: string; small?: boolean }) {
  return <img className={`utilities-icon${small ? " small" : ""}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(toolIconSvg(slug))}`} alt="" aria-hidden="true" draggable={false}/>;
}
