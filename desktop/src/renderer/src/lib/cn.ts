import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn/Radix-style class combiner.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
