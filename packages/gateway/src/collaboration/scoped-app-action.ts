import { z } from "zod/v4";
import { BridgeQueryBodySchema } from "../app-db-contracts.js";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const KeySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_./-]+$/);

/** Shared app KV uses the same owner Postgres store as the local app bridge, under a scope-derived namespace. */
export const ScopedAppActionSchema = z.union([
  BridgeQueryBodySchema,
  z.object({ app: AppIdSchema, action: z.literal("readData"), key: KeySchema }).strict(),
  z.object({ app: AppIdSchema, action: z.literal("writeData"), key: KeySchema, value: z.string().max(128 * 1024) }).strict(),
]);

export type ScopedAppAction = z.infer<typeof ScopedAppActionSchema>;
