import { z } from "zod/v4";
import { ManifestError } from "./errors.js";

export const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_RANGE = /^[\^~]?\d+\.\d+\.\d+$|^\d+\.\d+\.\d+$/;

const RuntimeEnum = z.enum(["static", "vite", "node"]);

const BuildSchema = z.object({
  install: z.string().default("pnpm install --frozen-lockfile"),
  command: z.string(),
  output: z.string(),
  timeout: z.number().int().positive().default(120),
  sourceGlobs: z.array(z.string()).default(["src/**", "public/**", "*.config.*", "index.html", "matrix.json"]),
});

const ServeSchema = z.object({
  start: z.string(),
  healthCheck: z.string().default("/"),
  startTimeout: z.number().int().positive().default(10),
  idleShutdown: z.number().int().positive().default(300),
});

const ResourcesSchema = z.object({
  memoryMb: z.number().int().positive().default(256),
  cpuShares: z.number().int().positive().default(512),
  maxFileHandles: z.number().int().positive().default(128),
}).default({ memoryMb: 256, cpuShares: 512, maxFileHandles: 128 });

const BaseManifestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SAFE_SLUG, "slug must match ^[a-z0-9][a-z0-9-]{0,63}$"),
  description: z.string().optional(),
  category: z.string().optional(),
  icon: z.string().optional(),
  author: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  runtime: RuntimeEnum,
  runtimeVersion: z.string().regex(SEMVER_RANGE, "runtimeVersion must be semver range"),
  scope: z.enum(["personal", "shared"]).default("personal"),
  build: BuildSchema.optional(),
  serve: ServeSchema.optional(),
  resources: ResourcesSchema,
  permissions: z.array(z.string()).default([]),
  storage: z.unknown().optional(),
  listingTrust: z.string().optional(),
});

function rejectDistributionStatus(input: unknown): unknown {
  if (
    typeof input === "object" &&
    input !== null &&
    "distributionStatus" in input
  ) {
    throw new z.ZodError([
      {
        code: "custom",
        message: "distributionStatus must not be authored in matrix.json — it is computed server-side",
        path: ["distributionStatus"],
      },
    ]);
  }
  return input;
}

export const AppManifestSchema = z.preprocess(rejectDistributionStatus, BaseManifestSchema)
  .refine(
    (m) => m.runtime === "static" || m.build !== undefined,
    { message: "runtime 'vite' and 'node' require 'build' section", path: ["build"] }
  ).refine(
    (m) => m.runtime !== "node" || m.serve !== undefined,
    { message: "runtime 'node' requires 'serve' section", path: ["serve"] }
  );

export type AppManifest = z.infer<typeof AppManifestSchema>;

export type ParseResult =
  | { ok: true; manifest: AppManifest }
  | { ok: false; error: ManifestError };

export async function parseManifest(input: unknown): Promise<ParseResult> {
  try {
    const manifest = AppManifestSchema.parse(input);
    return { ok: true, manifest };
  } catch (err) {
    return {
      ok: false,
      error: new ManifestError("invalid_manifest", err instanceof Error ? err.message : String(err)),
    };
  }
}
