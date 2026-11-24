import type { ReactNode } from "react";
import { dsCn as cn } from "./cn";

const SIZE_PX = { xs: 20, sm: 24, md: 32 } as const;
export type AvatarSize = keyof typeof SIZE_PX;

export function getInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words.at(-1)![0]}`.toUpperCase();
}

/** Design-library Avatar: neutral tint fallback with initials. */
export function Avatar({ name, size = "md", className }: { name: string; size?: AvatarSize; className?: string }) {
  const px = SIZE_PX[size];
  return (
    <span
      data-slot="ds-avatar"
      role="img"
      aria-label={name}
      className={cn("flex shrink-0 items-center justify-center rounded-full border border-ds-tint-neutral-border bg-ds-tint-neutral-fill font-ds-sans leading-none font-medium tracking-tight text-ds-tint-neutral-text select-none", className)}
      style={{ width: px, height: px, fontSize: Math.round(px * 0.4) }}
    >
      <span aria-hidden="true">{getInitials(name)}</span>
    </span>
  );
}

/** Overlapping avatars with a 2px background ring and an optional "+N" chip. */
export function AvatarGroup({ names, max = 4, size = "md", label }: { names: string[]; max?: number; size?: AvatarSize; label: string }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const px = SIZE_PX[size];
  let more: ReactNode = null;
  if (rest > 0) {
    more = (
      <span
        className="flex shrink-0 items-center justify-center rounded-full bg-ds-card font-ds-sans text-ds-ui-xs font-medium text-ds-muted-foreground ring-2 ring-ds-background"
        style={{ width: px, height: px }}
        aria-hidden="true"
      >
        +{rest}
      </span>
    );
  }
  return (
    <div role="group" aria-label={label} className="flex -space-x-1.5 *:ring-2 *:ring-ds-background">
      {shown.map((name) => <Avatar key={name} name={name} size={size} />)}
      {more}
    </div>
  );
}
