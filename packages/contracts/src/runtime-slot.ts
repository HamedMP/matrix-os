import { z } from "zod/v4";

/** Canonical Matrix runtime slot, including private Preview handles. */
export const MatrixComputerRuntimeSlotSchema = z.string().min(1).max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Invalid Matrix computer runtime slot");
