import { z } from "zod/v4";

export const NATIVE_APP_QUERY_CHANNEL = "native-app:query";
export const MAX_NATIVE_APP_QUERY_BYTES = 256 * 1024;
const MAX_NATIVE_APP_SUBSCRIPTIONS = 64;

const SafeNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const IdSchema = z.string().min(1).max(512);
const ComparableSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const FilterOperatorSchema = z.strictObject({
  $eq: ComparableSchema.optional(),
  $ne: ComparableSchema.optional(),
  $lt: z.union([z.string(), z.number()]).optional(),
  $lte: z.union([z.string(), z.number()]).optional(),
  $gt: z.union([z.string(), z.number()]).optional(),
  $gte: z.union([z.string(), z.number()]).optional(),
  $in: z.array(ComparableSchema).max(200).optional(),
  $like: z.string().max(4_096).optional(),
  $ilike: z.string().max(4_096).optional(),
}).refine((value) => Object.keys(value).length > 0);
const FilterSchema = z.record(SafeNameSchema, z.union([ComparableSchema, FilterOperatorSchema]));
const OrderBySchema = z.record(SafeNameSchema, z.enum(["asc", "desc"]));
const DataSchema = z.record(SafeNameSchema, z.json()).refine(
  (value) => Object.keys(value).length > 0,
);

const queryUnion = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("find"),
    table: SafeNameSchema,
    filter: FilterSchema.optional(),
    orderBy: OrderBySchema.optional(),
    limit: z.number().int().min(0).max(10_000).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  z.strictObject({ action: z.literal("findOne"), table: SafeNameSchema, id: IdSchema }),
  z.strictObject({ action: z.literal("insert"), table: SafeNameSchema, data: DataSchema }),
  z.strictObject({ action: z.literal("bulkInsert"), table: SafeNameSchema, rows: z.array(DataSchema).max(200) }),
  z.strictObject({ action: z.literal("update"), table: SafeNameSchema, id: IdSchema, data: DataSchema }),
  z.strictObject({
    action: z.literal("bulkUpdate"),
    table: SafeNameSchema,
    updates: z.array(z.strictObject({ id: IdSchema, data: DataSchema })).max(200),
  }),
  z.strictObject({ action: z.literal("delete"), table: SafeNameSchema, id: IdSchema }),
  z.strictObject({ action: z.literal("count"), table: SafeNameSchema, filter: FilterSchema.optional() }),
  z.strictObject({ action: z.literal("schema") }),
  z.strictObject({ action: z.literal("appInfo") }),
]);

export const NativeAppQuerySchema = queryUnion.refine((value) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_NATIVE_APP_QUERY_BYTES;
  } catch {
    return false;
  }
}, { message: "query payload too large" });

export type NativeAppQuery = z.infer<typeof NativeAppQuerySchema>;
export type NativeAppQueryInvoke = (query: NativeAppQuery) => Promise<unknown>;

export interface NativeAppDatabase {
  find(table: string, options?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    limit?: number;
    offset?: number;
  }): Promise<unknown[]>;
  findOne(table: string, id: string): Promise<unknown>;
  insert(table: string, data: Record<string, unknown>): Promise<{ id: string }>;
  bulkInsert(table: string, rows: Array<Record<string, unknown>>): Promise<unknown>;
  update(table: string, id: string, data: Record<string, unknown>): Promise<unknown>;
  bulkUpdate(table: string, updates: Array<{ id: string; data: Record<string, unknown> }>): Promise<unknown>;
  delete(table: string, id: string): Promise<unknown>;
  count(table: string, filter?: Record<string, unknown>): Promise<number>;
  schema(): Promise<unknown>;
  appInfo(): Promise<unknown>;
  onChange(table: string, callback: (event: { table: string }) => void): () => void;
}

function validatedInvoke(invoke: NativeAppQueryInvoke, raw: unknown): Promise<unknown> {
  const parsed = NativeAppQuerySchema.safeParse(raw);
  if (!parsed.success) return Promise.reject(new Error("invalid database query"));
  return invoke(parsed.data);
}

export function createNativeAppDatabase(invoke: NativeAppQueryInvoke): NativeAppDatabase {
  const subscriptions = new Map<number, {
    table: string;
    callback: (event: { table: string }) => void;
  }>();
  let nextSubscriptionId = 1;
  const notify = (table: string): void => {
    for (const subscription of subscriptions.values()) {
      if (subscription.table !== table) continue;
      try {
        subscription.callback({ table });
      } catch (error: unknown) {
        console.warn(
          "[native-app-bridge] data change callback failed:",
          error instanceof Error ? error.name : typeof error,
        );
      }
    }
  };
  const mutate = async (table: string, query: unknown): Promise<unknown> => {
    const result = await validatedInvoke(invoke, query);
    notify(table);
    return result;
  };

  return {
    find: async (table, options) => validatedInvoke(invoke, {
      action: "find",
      table,
      ...(options?.where ? { filter: options.where } : {}),
      ...(options?.orderBy ? { orderBy: options.orderBy } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.offset !== undefined ? { offset: options.offset } : {}),
    }) as Promise<unknown[]>,
    findOne: (table, id) => validatedInvoke(invoke, { action: "findOne", table, id }),
    insert: (table, data) => mutate(table, { action: "insert", table, data }) as Promise<{ id: string }>,
    bulkInsert: (table, rows) => mutate(table, { action: "bulkInsert", table, rows }),
    update: (table, id, data) => mutate(table, { action: "update", table, id, data }),
    bulkUpdate: (table, updates) => mutate(table, { action: "bulkUpdate", table, updates }),
    delete: (table, id) => mutate(table, { action: "delete", table, id }),
    count: async (table, filter) => {
      const value = await validatedInvoke(invoke, {
        action: "count",
        table,
        ...(filter ? { filter } : {}),
      });
      return typeof value === "object" && value !== null && "count" in value
        ? Number((value as { count: unknown }).count)
        : 0;
    },
    schema: () => validatedInvoke(invoke, { action: "schema" }),
    appInfo: () => validatedInvoke(invoke, { action: "appInfo" }),
    onChange: (table, callback) => {
      if (!SafeNameSchema.safeParse(table).success) {
        throw new Error("invalid database subscription");
      }
      const id = nextSubscriptionId++;
      subscriptions.set(id, { table, callback });
      while (subscriptions.size > MAX_NATIVE_APP_SUBSCRIPTIONS) {
        const oldest = subscriptions.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        subscriptions.delete(oldest);
      }
      return () => {
        subscriptions.delete(id);
      };
    },
  };
}
