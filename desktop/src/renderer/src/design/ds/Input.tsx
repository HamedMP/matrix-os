import type { ComponentProps } from "react";
import { dsCn as cn } from "./cn";

// Design-library Input: sizes line up with Button (sm 32 · md 36), 8px radius, gold focus ring.
export function Input({ className, inputSize = "md", ...props }: ComponentProps<"input"> & { inputSize?: "sm" | "md" }) {
  return (
    <input
      data-slot="ds-input"
      className={cn(
        "ds-focus w-full min-w-0 rounded-md border border-ds-input bg-ds-background px-3 font-ds-sans text-ds-ui text-ds-foreground shadow-ds-xs outline-none",
        "placeholder:text-ds-muted-foreground disabled:cursor-not-allowed disabled:bg-ds-muted disabled:opacity-60",
        "aria-invalid:border-ds-destructive",
        inputSize === "sm" ? "h-8" : "h-9",
        className,
      )}
      {...props}
    />
  );
}
