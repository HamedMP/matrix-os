import { z } from "zod/v4";

// Peer `sync:change` broadcasts the home mirror applies. Bounded so a
// misbehaving peer cannot hand the mirror unbounded batches or paths.
const RemoteChangeFileSchema = z.object({
  path: z.string().min(1).max(1024),
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  action: z.enum(["add", "update", "delete"]).optional(),
});
export const RemoteChangeMessageSchema = z.object({
  type: z.literal("sync:change"),
  files: z.array(RemoteChangeFileSchema).max(100),
  peerId: z.string().min(1).max(128).optional(),
});

export type RemoteChangeMessage = z.infer<typeof RemoteChangeMessageSchema>;
