import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx } from "./internal";

interface FieldShell {
  label: string;
  /** Visually hide the label but keep it accessible. */
  hideLabel?: boolean;
  hint?: ReactNode;
  /** Validation message; sets aria-invalid. */
  error?: string | null;
  className?: string;
}

export interface TextFieldProps extends FieldShell {
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "search" | "url" | "number" | "password" | "date" | "time" | "datetime-local";
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  id?: string;
  /** Extra attributes forwarded to the input or textarea. */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> &
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">;
}

export function TextField({
  label,
  hideLabel,
  hint,
  error,
  className,
  value,
  onChange,
  type = "text",
  placeholder,
  multiline,
  rows = 4,
  disabled,
  autoFocus,
  maxLength,
  id,
  inputProps,
}: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const shared = {
    id: fieldId,
    value,
    placeholder,
    disabled,
    autoFocus,
    maxLength,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: "oui-input",
  };
  return (
    <div className={cx("oui-field", className)}>
      <label htmlFor={fieldId} className={cx("oui-field__label", hideLabel && "oui-sr-only")}>{label}</label>
      {multiline ? (
        <textarea {...inputProps} {...shared} rows={rows} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...inputProps} {...shared} type={type} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint && <span id={hintId} className="oui-field__hint">{hint}</span>}
      {error && <span id={errorId} className="oui-field__error">{error}</span>}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends FieldShell {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  id?: string;
}

export function Select({ label, hideLabel, hint, error, className, value, onChange, options, disabled, id }: SelectProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("oui-field", className)}>
      <label htmlFor={fieldId} className={cx("oui-field__label", hideLabel && "oui-sr-only")}>{label}</label>
      <span className="oui-select">
        <select
          id={fieldId}
          className="oui-input oui-select__control"
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
          ))}
        </select>
      </span>
      {hint && <span id={hintId} className="oui-field__hint">{hint}</span>}
      {error && <span id={errorId} className="oui-field__error">{error}</span>}
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  description?: ReactNode;
  className?: string;
  id?: string;
}

export function Checkbox({ label, checked, onChange, indeterminate = false, disabled, description, className, id }: CheckboxProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <div className={cx("oui-checkbox", disabled && "is-disabled", className)}>
      <input
        ref={ref}
        id={fieldId}
        type="checkbox"
        className="oui-checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked}
        aria-describedby={description ? `${fieldId}-desc` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={fieldId} className="oui-checkbox__label">
        {label}
        {description && <span id={`${fieldId}-desc`} className="oui-field__hint">{description}</span>}
      </label>
    </div>
  );
}
