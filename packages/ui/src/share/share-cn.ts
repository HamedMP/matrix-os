import { twMerge } from "tailwind-merge";
import { cn as join } from "../cn";

export const cn = (...values: (string | undefined | null | false)[]) => twMerge(join(...values));
