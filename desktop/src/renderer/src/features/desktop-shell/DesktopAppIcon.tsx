import type { CSSProperties, ReactNode } from "react";

export default function DesktopAppIcon({
  icon,
  name,
  color,
  iconColor,
  className = "",
  style,
}: {
  /** The visual content of this application icon. */
  icon: ReactNode;
  /** Accessible application name shared by grid and Dock instances. */
  name: string;
  /** Optional app surface color; falls back to the current surface treatment. */
  color?: string;
  /** Optional icon foreground color; falls back to the current accent color. */
  iconColor?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      data-desktop-app-icon
      aria-label={name}
      className={`flex items-center justify-center overflow-hidden ${className}`}
      style={{
        ...(color ? { background: color } : {}),
        ...(iconColor ? { color: iconColor } : {}),
        ...style,
      }}
    >
      <span
        data-desktop-app-icon-shine
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: "50%",
          background: "linear-gradient(180deg, rgba(255, 255, 255, 0.40) 0%, rgba(255, 255, 255, 0.00) 100%)",
        }}
      />
      <span className="relative z-10">{icon}</span>
    </span>
  );
}
