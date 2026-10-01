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
  return <Icon data-icon="settings-gear" {...props}>
    <path transform="scale(.8333)" d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="10" cy="10" r="2.5" />
  </Icon>;
}
