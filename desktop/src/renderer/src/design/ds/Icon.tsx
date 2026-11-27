import type { LucideIcon } from "lucide-react";
import type { SVGProps } from "react";

// Matrix icons are Lucide on a 24px grid (design library, decided 2026-09-30).
// Stroke is 2 on the grid, never painted thinner than 1.25px:
// strokeWidth = max(2, 1.25 × 24 / size).
export const ICON_SIZES = { xxs: 12, xs: 14, sm: 16, md: 20, lg: 24 } as const;
export type IconSize = keyof typeof ICON_SIZES;

const MIN_PAINT = 1.25;
const BASE_STROKE = 2;

export function iconStrokeWidth(size: IconSize): number {
  const px = ICON_SIZES[size];
  return (BASE_STROKE * px) / 24 < MIN_PAINT ? (MIN_PAINT * 24) / px : BASE_STROKE;
}

export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref" | "size" | "strokeWidth"> & {
  icon: LucideIcon;
  size?: IconSize;
};

/** One Lucide icon at a Matrix size. Decorative unless given an aria-label. */
export function Icon({ icon: Glyph, size = "sm", "aria-label": ariaLabel, ...props }: IconProps) {
  const a11y = ariaLabel ? { "aria-label": ariaLabel, role: "img" as const } : { "aria-hidden": true as const };
  return <Glyph size={ICON_SIZES[size]} strokeWidth={iconStrokeWidth(size)} {...a11y} {...props} />;
}
