import type { SVGProps } from "react";

/** Discord brand mark drawn inline: a CSS mask over a bundled SVG breaks when the
 * bundler inlines it as a data URL, so menus render this instead. */
export function DiscordIcon({ size = 14, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M19.3 5.3A16.9 16.9 0 0 0 15.1 4l-.5 1.1a15.7 15.7 0 0 0-5.2 0L8.9 4a16.9 16.9 0 0 0-4.2 1.3C2 9.3 1.3 13.2 1.6 17.1a17 17 0 0 0 5.2 2.6l1.1-1.8c-.6-.2-1.2-.5-1.7-.9l.4-.3a12.1 12.1 0 0 0 10.8 0l.4.3c-.5.4-1.1.7-1.7.9l1.1 1.8a17 17 0 0 0 5.2-2.6c.4-4.5-.7-8.4-3.1-11.8ZM8.7 14.8c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1Zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1Z" />
  </svg>;
}
