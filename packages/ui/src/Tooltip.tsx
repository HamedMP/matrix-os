import { useState, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn.js";

export interface TooltipProps extends HTMLAttributes<HTMLDivElement> {
  content: ReactNode;
  children: ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

const tooltipStyle: React.CSSProperties = {
  position: "absolute",
  padding: "6px 12px",
  background: "var(--matrix-fg)",
  color: "var(--matrix-card)",
  fontSize: "0.8125rem",
  fontFamily: "var(--matrix-font-sans)",
  borderRadius: "var(--matrix-radius-sm)",
  whiteSpace: "nowrap",
  zIndex: 100,
  pointerEvents: "none",
  opacity: 0,
  transition: "opacity 0.15s ease-out",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
};

const positionMap: Record<string, React.CSSProperties> = {
  top: { bottom: "100%", left: "50%", transform: "translateX(-50%)", marginBottom: "6px" },
  bottom: { top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: "6px" },
  left: { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: "6px" },
  right: { left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: "6px" },
};

export function Tooltip({
  content,
  children,
  position = "top",
  delay = 300,
  className,
  ...rest
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  return (
    <div
      className={cn("matrix-tooltip-wrapper", className)}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      {...rest}
    >
      {children}
      <div
        className="matrix-tooltip"
        role="tooltip"
        style={{
          ...tooltipStyle,
          ...positionMap[position],
          opacity: visible ? 1 : 0,
        }}
      >
        {content}
      </div>
    </div>
  );
}
