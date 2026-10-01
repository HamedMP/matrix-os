import type { SVGProps } from "react";

// Inline 20px stroke icons for the Aoede panel. @matrix-os/ui carries no icon
// dependency; the shell maps its own set, so the panel ships the few it needs.
type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export function AoedeCloseIcon(props: IconProps) {
  return <Icon {...props}><path d="M5 5l10 10M15 5L5 15" /></Icon>;
}

export function AoedeNewIcon(props: IconProps) {
  return <Icon {...props}><path d="M10 4v12M4 10h12" /></Icon>;
}

export function AoedeHistoryIcon(props: IconProps) {
  return <Icon {...props}><path d="M3.5 10a6.5 6.5 0 1 0 1.9-4.6" /><path d="M3.5 3.5v3.2h3.2" /><path d="M10 6.5V10l2.5 1.6" /></Icon>;
}

export function AoedeSettingsIcon(props: IconProps) {
  return <Icon {...props}><circle cx="10" cy="10" r="2.4" /><path d="M10 2.8v1.9M10 15.3v1.9M2.8 10h1.9M15.3 10h1.9M4.9 4.9l1.35 1.35M13.75 13.75l1.35 1.35M4.9 15.1l1.35-1.35M13.75 6.25l1.35-1.35" /></Icon>;
}

