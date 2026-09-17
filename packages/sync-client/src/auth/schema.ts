import { z } from "zod/v4";

export const AuthDataSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().nonnegative(),
  userId: z.string().min(1),
  handle: z.string().min(1),
  runtimeSlot: z.string().min(1).max(32).optional(),
});

export type AuthData = z.infer<typeof AuthDataSchema>;
