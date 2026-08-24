import { z } from "zod/v4";

const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;
export const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNSAFE_DISPLAY_TEXT =
  /(stack trace|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
export const textEncoder = new TextEncoder();

export function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function boundedText(maxChars: number, maxBytes = maxChars * 4) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value.trim().length > 0, { message: "Text cannot be blank" })
    .refine((value) => byteLength(value) <= maxBytes, { message: "Text exceeds byte limit" });
}

export function boundedDisplayText(maxChars: number, maxBytes = maxChars * 4) {
  return boundedText(maxChars, maxBytes)
    .refine((value) => !UNSAFE_DISPLAY_TEXT.test(value), { message: "Text is not safe for display" });
}

export function prefixedId(prefix: string, maxBody = 128) {
  return z.string()
    .min(prefix.length + 1)
    .max(prefix.length + maxBody)
    .startsWith(prefix)
    .refine((value) => SAFE_ID_BODY.test(value.slice(prefix.length)), { message: "Invalid identifier" });
}

export function referenceId(max = 128) {
  return z.string()
    .min(1)
    .max(max)
    .regex(SAFE_REFERENCE, "Invalid reference identifier")
    .refine((value) => !value.includes(".."), { message: "Reference cannot contain traversal" });
}

export function safeRelativePath(max = 512) {
  return z.string()
    .min(1)
    .max(max)
    .refine((value) => !value.startsWith("/") && !value.includes("\0"), { message: "Invalid path" })
    .refine((value) => !value.split(/[\\/]+/).some((part) => part === "" || part === "." || part === ".."), {
      message: "Path traversal is not allowed",
    });
}
