import { z } from "zod/v4";
import {
  CanonicalOperationResultViewSchema,
  CanonicalOperationViewSchema,
  type CanonicalOperation,
  type CanonicalOperationResultView,
  type CanonicalOperationView,
} from "@matrix-os/contracts";

/**
 * Safe client projection for canonical action operations. Raw `arguments`,
 * raw tool output and `claimToken` never leave the server: each known toolId
 * projects only its whitelisted result fields, every extracted value is
 * revalidated against the view contract, and unknown or malformed results
 * project no result detail at all.
 */

const ref = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const appSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** Mirrors the contract's segment-safe workspace path: `apps/timer/src/main.tsx`, never `..` or absolute. */
const pathRef = (max: number) => z.string().min(1).max(max).refine(
  (value) => value.split("/").every((segment) => /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(segment)),
);

const NavigationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open_app"), app: ref(80), path: pathRef(160) }),
  z.object({ kind: z.literal("close_app"), app: ref(80), path: pathRef(160) }),
]);
const ArtifactSchema = z.object({ kind: ref(40), path: pathRef(160) });
const AppEntrySchema = z.object({ app: ref(80), name: z.string().min(1).max(160) });
const FileEntrySchema = z.object({
  path: pathRef(160),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  truncated: z.boolean().optional(),
});
const MatchEntrySchema = z.object({
  path: pathRef(160),
  line: z.number().int().min(1).max(1_000_000),
  text: z.string().max(240),
});

type ResultRecord = Record<string, unknown>;

const asRecord = (value: unknown): ResultRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as ResultRecord : null;

function pick<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Keeps only schema-valid entries; malformed elements are dropped, never projected. */
function pickList<Schema extends z.ZodType>(schema: Schema, value: unknown): Array<z.infer<Schema>> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 32).flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A result bucket that resolved to no whitelisted fields stays absent on the wire. */
function assemble(parts: Partial<CanonicalOperationResultView>): CanonicalOperationResultView | undefined {
  const candidate = Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined));
  if (Object.keys(candidate).length === 0) return undefined;
  const parsed = CanonicalOperationResultViewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function operationApp(op: CanonicalOperation, result: ResultRecord): string | undefined {
  const args = asRecord(op.arguments);
  const app = pick(appSlug, args?.app);
  const resultApp = result.app === undefined ? app : pick(appSlug, result.app);
  return app && resultApp === app ? app : undefined;
}

function qualifyAppPath(app: string, value: unknown): string | undefined {
  const path = pick(pathRef(160), value);
  if (!path) return undefined;
  const root = `apps/${app}`;
  if (path === root || path.startsWith(`${root}/`)) return path;
  if (path.startsWith("apps/")) return undefined;
  return pick(pathRef(160), `${root}/${path}`);
}

function qualifiedFiles(app: string, value: unknown): CanonicalOperationResultView["files"] {
  const files = pickList(FileEntrySchema, value);
  return files?.flatMap((file) => {
    const path = qualifyAppPath(app, file.path);
    return path ? [{ ...file, path }] : [];
  });
}

const projectors: Record<string, (result: ResultRecord, op: CanonicalOperation) => CanonicalOperationResultView | undefined> = {
  matrix_create_note: (result, op) => {
    const app = operationApp(op, result);
    const navigation = pick(NavigationSchema, result.navigation);
    return app === "notes" && navigation?.kind === "open_app" && navigation.app === app && navigation.path === "apps/notes"
      ? assemble({ navigation }) : undefined;
  },
  matrix_edit_note: (result, op) => {
    const app = operationApp(op, result);
    const navigation = pick(NavigationSchema, result.navigation);
    return app === "notes" && navigation?.kind === "open_app" && navigation.app === app && navigation.path === "apps/notes"
      ? assemble({ navigation }) : undefined;
  },
  // Result is `{...inspect, navigation}`; only the navigation intent projects.
  matrix_open_app: (result, op) => {
    const app = operationApp(op, result);
    if (!app) return undefined;
    const navigation = pick(NavigationSchema, result.navigation);
    return assemble({
      navigation: navigation?.kind === "open_app" && navigation.app === app && navigation.path === `apps/${app}` ? navigation : undefined,
    });
  },
  matrix_close_app: (result, op) => {
    const app = operationApp(op, result);
    if (!app) return undefined;
    const navigation = pick(NavigationSchema, result.navigation);
    return assemble({
      navigation: navigation?.kind === "close_app" && navigation.app === app && navigation.path === `apps/${app}` ? navigation : undefined,
    });
  },
  matrix_apply_app_files: (result, op) => {
    const app = operationApp(op, result);
    if (!app) return undefined;
    const artifact = pick(ArtifactSchema, result.artifact);
    const navigation = pick(NavigationSchema, result.navigation);
    return assemble({
      artifact: artifact?.path === `apps/${app}` ? artifact : undefined,
      navigation: navigation?.kind === "open_app" && navigation.app === app && navigation.path === `apps/${app}` ? navigation : undefined,
      files: qualifiedFiles(app, result.files),
    });
  },
  matrix_list_apps: (result) => assemble({
    apps: pickList(AppEntrySchema, result.apps),
  }),
  // `text` file bodies never project; `path: "apps/<slug>"` folds into artifact.
  matrix_inspect_app: (result, op) => {
    const app = operationApp(op, result);
    if (!app) return undefined;
    const appPath = qualifyAppPath(app, result.path);
    return assemble({
      artifact: appPath === `apps/${app}` ? pick(ArtifactSchema, { kind: "app", path: appPath }) : undefined,
      files: qualifiedFiles(app, result.files),
    });
  },
  matrix_search_workspace: (result, op) => {
    const app = operationApp(op, result);
    if (!app) return undefined;
    const matches = pickList(MatchEntrySchema, result.matches)?.filter((match) =>
      qualifyAppPath(app, match.path) === match.path
    );
    return assemble({ matches });
  },
};

export function toOperationView(op: CanonicalOperation): CanonicalOperationView {
  const source = asRecord(op.result);
  const result = source === null ? undefined : projectors[op.toolId]?.(source, op);
  return CanonicalOperationViewSchema.parse({
    id: op.id,
    chatId: op.chatId,
    runId: op.runId,
    toolId: op.toolId,
    schemaRevision: op.schemaRevision,
    policyRevision: op.policyRevision,
    state: op.state,
    argumentDigest: op.argumentDigest,
    cancellationRequested: op.cancellationRequested,
    ...(result === undefined ? {} : { result }),
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
  });
}
