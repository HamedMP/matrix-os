import { z } from "zod/v4";

export const SAFE_SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const IsoTimestampSchema = z.string().regex(
  ISO_DATETIME,
  "Invalid ISO timestamp",
);
