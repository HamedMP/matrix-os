"use client";
import type { CSSProperties, ComponentProps } from "react";
import { chatWidget } from "@matrix-os/brand/tokens";
import { rabbitMarkSvg } from "@matrix-os/brand/marks";
import "./chat-presentation.css";

const rabbit = `data:image/svg+xml,${encodeURIComponent(rabbitMarkSvg("matrix-mark").replace("currentColor", "white"))}`;
export function MatrixChatAvatar({ className = "" }: { className?: string }) {
  return <span className={`matrix-chat-avatar ${className}`} aria-hidden="true"><img src={rabbit} alt="" /></span>;
}

/** One scoped Figma presentation for Web Canvas, Web Desktop and Electron
 * Desktop. The host supplies navigation/chrome; transcript behavior stays intact.
 */
export function ChatPresentation({ className = "", style, ...props }: ComponentProps<"div">) {
  const colors = chatWidget.colors;
  return <div {...props} data-matrix-chat className={`matrix-chat-presentation ${className}`} style={{
    "--font-ui": chatWidget.fontFamily, "--font-sans": chatWidget.fontFamily,
    "--chat-font": chatWidget.fontFamily, "--chat-surface": colors.surface,
    "--chat-border": colors.border, "--chat-text": colors.text, "--chat-ink": colors.ink,
    "--chat-muted": colors.muted, "--chat-placeholder": colors.placeholder,
    "--chat-composer": colors.composer, "--chat-secondary": colors.secondary,
    "--background": colors.surface, "--foreground": colors.text,
    "--bg-app": colors.surface, "--bg-surface": colors.surface, "--bg-raised": colors.composer,
    "--bg-sunken": colors.secondary, "--bg-hover": colors.secondary, "--bg-selected": colors.secondary,
    "--text-primary": colors.text, "--text-secondary": colors.muted, "--text-tertiary": colors.placeholder,
    "--border-default": colors.border, "--border-subtle": colors.border,
    ...style,
  } as CSSProperties} />;
}
