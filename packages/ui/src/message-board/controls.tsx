import type { CSSProperties } from "react";
import { Button, type ButtonProps } from "../Button.js";
import { Input, type InputProps } from "../Input.js";
import {
  actionButtonClass, chipClass, iconButtonClass, primaryButtonClass, subtleBorder, textPrimary,
} from "./presentation.js";

/**
 * The board's buttons and fields are the shared `Button` and `Input`. A look
 * picks the shared variant and the board's compact size; the shared component
 * keeps its weight, and the board's classes drive size, shape, hover and focus.
 */
export type BoardButtonLook = "primary" | "action" | "icon" | "chip" | "plain";

const VARIANT = { primary: "primary", action: "secondary", icon: "ghost", chip: "ghost", plain: "ghost" } as const;
const LOOK_CLASS: Record<BoardButtonLook, string> = {
  primary: primaryButtonClass, action: actionButtonClass, icon: iconButtonClass, chip: chipClass, plain: "",
};

/** Lets the board's classes size the control instead of the shared inline defaults. */
const COMPACT: CSSProperties = {
  padding: undefined, width: undefined, height: undefined, fontSize: undefined, gap: undefined,
  borderRadius: undefined, lineHeight: undefined, justifyContent: undefined, display: undefined,
};
/** Ghost looks leave fill and frame to the board's hover, pressed and border classes. */
const CLEAR_FRAME: CSSProperties = { background: undefined, border: undefined };
/** Text-like buttons (links, pills, menu items) also take their color and weight from where they sit. */
const INHERIT_TEXT: CSSProperties = { ...CLEAR_FRAME, color: undefined, fontWeight: undefined, fontFamily: undefined };
/**
 * The shared `--matrix-*` colors are fixed light values; the shell theme tokens
 * come first so the board follows light, dark and custom themes.
 */
const THEMED_TEXT: CSSProperties = { color: "var(--text-primary, var(--foreground, var(--matrix-fg)))" };
const LOOK_STYLE: Record<BoardButtonLook, CSSProperties> = {
  primary: { background: "var(--primary, var(--matrix-primary))", color: "var(--primary-foreground, var(--matrix-primary-fg))" },
  action: { background: undefined, ...THEMED_TEXT, ...subtleBorder },
  icon: { ...CLEAR_FRAME, ...THEMED_TEXT },
  chip: { ...CLEAR_FRAME, ...THEMED_TEXT },
  plain: INHERIT_TEXT,
};

export function BoardButton({ look, className, style, ...props }: Omit<ButtonProps, "variant" | "size"> & { look: BoardButtonLook }) {
  return <Button variant={VARIANT[look]} size="sm" className={`${LOOK_CLASS[look]} ${className ?? ""}`.trim()}
    style={{ ...COMPACT, ...LOOK_STYLE[look], ...style }} {...props} />;
}

const FIELD_STYLE: CSSProperties = {
  height: 32, padding: "0 10px", fontSize: 13, borderRadius: 10, background: "transparent", ...subtleBorder, ...textPrimary,
};
const FIELD_FOCUS = "[&_input:focus-visible]:ring-2 [&_input:focus-visible]:ring-[var(--composer-focus,var(--primary,currentColor))]";
/** Inside a bordered search row: the row draws the frame. */
const BARE_FIELD_STYLE: CSSProperties = { padding: 0, border: "none", background: "transparent", fontSize: "inherit", ...textPrimary };

/** The shared `Input`; `wrapperClassName` sizes it in the row, `bare` drops its frame. */
export function BoardInput({ wrapperClassName, bare, style, ...props }: Omit<InputProps, "className" | "label" | "error"> & { wrapperClassName?: string; bare?: boolean }) {
  // The shared field draws no focus state of its own; the board's focus ring goes on the inner input.
  return <Input className={`min-w-0 ${bare ? "" : FIELD_FOCUS} ${wrapperClassName ?? ""}`.trim()}
    style={{ ...(bare ? BARE_FIELD_STYLE : FIELD_STYLE), ...style }} {...props} />;
}
