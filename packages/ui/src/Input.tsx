import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  error?: string;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: "var(--matrix-card)",
  color: "var(--matrix-fg)",
  border: "1px solid var(--matrix-input)",
  borderRadius: "var(--matrix-radius-md)",
  fontSize: "0.875rem",
  fontFamily: "var(--matrix-font-sans)",
  transition: "border-color 0.15s ease-out, box-shadow 0.15s ease-out",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: "4px",
  fontSize: "0.875rem",
  fontWeight: 500,
  color: "var(--matrix-fg)",
};

const errorStyle: React.CSSProperties = {
  marginTop: "4px",
  fontSize: "0.8125rem",
  color: "var(--matrix-destructive)",
};

export function Input({ label, error, className, style, id, ...rest }: InputProps) {
  const inputId = id || (typeof label === "string" ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className={cn("matrix-input-wrapper", className)}>
      {label && (
        <label htmlFor={inputId} style={labelStyle}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className="matrix-input"
        style={{
          ...inputStyle,
          ...(error ? { borderColor: "var(--matrix-destructive)" } : {}),
          ...style,
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && inputId ? `${inputId}-error` : undefined}
        {...rest}
      />
      {error && (
        <p
          id={inputId ? `${inputId}-error` : undefined}
          style={errorStyle}
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
