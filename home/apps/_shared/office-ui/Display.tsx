import { useState, type ReactNode } from "react";
import { cx } from "./internal";

export interface AvatarProps {
  /** Person or account name; used for initials and the accessible name. */
  name: string;
  src?: string;
  size?: number;
  className?: string;
}

/** Initials from up to two words; email addresses use the local part. */
export function initialsFor(name: string): string {
  const base = name.includes("@") ? name.split("@")[0].replace(/[._-]+/g, " ") : name;
  const words = base.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`;
  return letters.toUpperCase();
}

export function Avatar({ name, src, size = 28, className }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = src && failed !== src;
  return (
    <span
      role="img"
      aria-label={name}
      className={cx("oui-avatar", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {showImage ? <img src={src} alt="" onError={() => setFailed(src)} /> : <span aria-hidden="true">{initialsFor(name)}</span>}
    </span>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}

export function Badge({ children, tone = "neutral", className }: BadgeProps) {
  return <span className={cx("oui-badge", `oui-badge--${tone}`, className)}>{children}</span>;
}

export interface KeyHintProps {
  /** One key or a chord, e.g. ["Ctrl", "Enter"] or "Esc". */
  keys: string | readonly string[];
  className?: string;
}

export function KeyHint({ keys, className }: KeyHintProps) {
  const list = typeof keys === "string" ? [keys] : keys;
  return (
    <span className={cx("oui-keyhint", className)}>
      {list.map((key, index) => (
        <kbd key={`${key}-${index}`}>{key}</kbd>
      ))}
    </span>
  );
}
