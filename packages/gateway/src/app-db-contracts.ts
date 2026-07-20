import { z } from "zod/v4";
import { isSafeName } from "./app-db-types.js";

const SafeNameSchema = z.string().refine(isSafeName, { message: "invalid app database name" });
const IdSchema = z.string().min(1).max(512);

const ComparableSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const FilterOperatorSchema = z.object({
  $eq: ComparableSchema.optional(),
  $ne: ComparableSchema.optional(),
  $lt: z.union([z.string(), z.number()]).optional(),
  $lte: z.union([z.string(), z.number()]).optional(),
  $gt: z.union([z.string(), z.number()]).optional(),
  $gte: z.union([z.string(), z.number()]).optional(),
  $in: z.array(ComparableSchema).max(200).optional(),
  $like: z.string().optional(),
  $ilike: z.string().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "filter operators must not be empty",
});

const FilterValueSchema = z.union([ComparableSchema, FilterOperatorSchema]);
const FilterSchema = z.record(SafeNameSchema, FilterValueSchema);
const OrderBySchema = z.record(SafeNameSchema, z.enum(["asc", "desc"]));
const AppDataRecordSchema = z.record(SafeNameSchema, z.json()).refine(
  (value) => Object.keys(value).length > 0,
  { message: "data rows must not be empty" },
);

const AppTableSchema = {
  app: SafeNameSchema,
  table: SafeNameSchema,
};

/** Complete route-boundary contract for the sandboxed app database bridge. */
export const BridgeQueryBodySchema = z.discriminatedUnion("action", [
  z.object({
    ...AppTableSchema,
    action: z.literal("find"),
    filter: FilterSchema.optional(),
    orderBy: OrderBySchema.optional(),
    limit: z.number().int().min(0).max(10_000).optional(),
    offset: z.number().int().min(0).optional(),
  }).strict(),
  z.object({ ...AppTableSchema, action: z.literal("findOne"), id: IdSchema }).strict(),
  z.object({ ...AppTableSchema, action: z.literal("insert"), data: AppDataRecordSchema }).strict(),
  z.object({
    ...AppTableSchema,
    action: z.literal("bulkInsert"),
    rows: z.array(AppDataRecordSchema).max(200),
  }).strict(),
  z.object({
    ...AppTableSchema,
    action: z.literal("update"),
    id: IdSchema,
    data: AppDataRecordSchema,
  }).strict(),
  z.object({
    ...AppTableSchema,
    action: z.literal("bulkUpdate"),
    updates: z.array(z.object({
      id: IdSchema,
      data: AppDataRecordSchema,
    }).strict()).max(200),
  }).strict(),
  z.object({ ...AppTableSchema, action: z.literal("delete"), id: IdSchema }).strict(),
  z.object({
    ...AppTableSchema,
    action: z.literal("count"),
    filter: FilterSchema.optional(),
  }).strict(),
  z.object({ app: SafeNameSchema, action: z.literal("schema") }).strict(),
  z.object({ app: SafeNameSchema, action: z.literal("appInfo") }).strict(),
  z.object({ action: z.literal("listApps") }).strict(),
]);

export type BridgeQueryBody = z.infer<typeof BridgeQueryBodySchema>;
