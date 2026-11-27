import * as RadixSwitch from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { dsCn as cn } from "./cn";

// Design-library Switch (md: 20 × 36): fully rounded, on uses --primary.
export function Switch({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      data-slot="ds-switch"
      className={cn(
        "ds-focus inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-[120ms]",
        "data-[state=checked]:bg-ds-primary data-[state=unchecked]:bg-ds-input",
        "disabled:cursor-not-allowed disabled:data-[state=unchecked]:bg-ds-muted disabled:data-[state=checked]:bg-ds-muted-foreground",
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="pointer-events-none block size-4 rounded-full bg-ds-background shadow-ds-xs transition-transform duration-[120ms] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
    </RadixSwitch.Root>
  );
}
