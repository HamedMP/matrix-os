import type { ComponentProps } from "react";

/** Shared by private and collaborative Chat timelines on every DOM shell. */
export function ChatHumanMessageBubble({ className = "", style, ...props }: ComponentProps<"div">) {
  return <div data-slot="bubble-content" data-selectable
    className={`w-fit min-w-0 max-w-full overflow-hidden rounded-2xl border px-4 py-3 text-[14px] leading-relaxed [overflow-wrap:anywhere] ${className}`}
    style={{ background: "color-mix(in srgb, var(--text-primary) 7%, var(--bg-surface))",
      borderColor: "color-mix(in srgb, var(--text-primary) 6%, transparent)", ...style }} {...props} />;
}
