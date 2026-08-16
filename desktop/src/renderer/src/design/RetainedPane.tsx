import type { CSSProperties, HTMLAttributes } from "react";

interface RetainedPaneProps extends Omit<HTMLAttributes<HTMLElement>, "aria-hidden" | "inert"> {
  active: boolean;
  as?: "div" | "section";
  background?: CSSProperties["background"];
}

/**
 * Keeps stateful UI mounted while making inactive siblings unable to paint or
 * participate in pointer, keyboard, or accessibility interaction.
 */
export default function RetainedPane({
  active,
  as: Element = "div",
  background,
  style,
  ...props
}: RetainedPaneProps) {
  return (
    <Element
      {...props}
      data-retained-pane
      data-active={String(active)}
      aria-hidden={!active}
      inert={!active}
      style={{
        ...style,
        display: active ? "flex" : "none",
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
        ...(background ? { background } : {}),
      }}
    />
  );
}
