import { z } from "zod/v4";

export const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export const ProviderModelReferenceSchema = z.string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]*)*$/,
    "Invalid model reference",
  )
  .refine((value) => !value.includes(".."), {
    message: "Model reference cannot contain traversal",
  })
  .refine((value) => !/^[A-Za-z]:\//.test(value), {
    message: "Model reference cannot be an absolute path",
  });

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const IsoTimestampSchema = z.string().regex(
  ISO_DATETIME,
  "Invalid ISO timestamp",
);
