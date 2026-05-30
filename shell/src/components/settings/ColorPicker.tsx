"use client";

import { useId } from "react";

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}

export function ColorPicker({ value, onChange, label }: ColorPickerProps) {
  const inputId = useId();
  return (
    <div className="space-y-1">
      {label && (
        <label htmlFor={inputId} className="text-xs text-muted-foreground">
          {label}
        </label>
      )}
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label ?? "Color"}
          className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
        />
        <span className="text-xs font-mono text-muted-foreground">
          {value}
        </span>
      </div>
    </div>
  );
}
