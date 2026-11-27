import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  APP_FILE_ERROR_STATUS, APP_FILE_MAX_BYTES, AppFileRequestSchema, MAX_APP_FILE_REQUEST_BYTES,
  appFileBase64ByteLength, appFileErrorBody, type AppFileErrorCode, type AppFileInput,
} from "@matrix-os/contracts/app-files";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { appFilesAllowed } from "./access.js";
import { APP_FILE_ADMISSION_DEFAULTS, createAppFileAdmission } from "./admission.js";
import { AppFileError, appFileErrorCodeFor, logAppFileFailure } from "./errors.js";
import { createProjectWriteGuard, unguardedProjectWrite, type ProjectWriteGuard } from "./project-write-fence.js";
import { listAppFiles, readAppFile, statAppFile } from "./read-ops.js";
import { mkdirAppFile, writeAppFile } from "./write-ops.js";

export interface AppFileRouteOptions {
  /** Owner home. Empty or missing means the server is misconfigured: every request is `unavailable`. */
  homePath: string | null | undefined;
  /** Every identity the owner is known by. A request must come in as one; a write is fenced by the projects of all. */
  ownerIds: readonly string[];
  /** The authenticated principal, or null. May throw when no principal can be resolved. */
  resolveOwner: (context: Context) => string | null;
  /**
   * The collaboration fence of the owner file routes. With it, a write or
   * mkdir inside a shared or mid-transition project is refused; without it
   * (no collaboration database) every write is admitted.
   */
  projectPathAdmission?: LegacyProjectPathAdmission;
}

/** Per app identity, the same budget as the app capability route; a global ceiling bounds all apps. */
export const APP_FILE_RATE_LIMIT_PER_MINUTE = APP_FILE_ADMISSION_DEFAULTS.perAppRatePerMinute;
export const APP_FILE_MAX_IN_FLIGHT = APP_FILE_ADMISSION_DEFAULTS.perAppMaxInFlight;

function fail(context: Context, code: AppFileErrorCode): Response {
  return context.json(appFileErrorBody(code), APP_FILE_ERROR_STATUS[code]);
}

/** A canonical-base64 body whose decoded size exceeds the cap is too large, not malformed. */
function oversizedWrite(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const input = (body as { input?: unknown }).input;
  if (typeof input !== "object" || input === null) return false;
  const { kind, contentBase64 } = input as { kind?: unknown; contentBase64?: unknown };
  return kind === "files.write" && typeof contentBase64 === "string" && appFileBase64ByteLength(contentBase64) > APP_FILE_MAX_BYTES;
}

async function runOperation(homePath: string, input: AppFileInput, guard: ProjectWriteGuard): Promise<unknown> {
  switch (input.kind) {
    case "files.list": return listAppFiles(homePath, input.dir, input.limit);
    case "files.stat": return statAppFile(homePath, input.path);
    case "files.read": return readAppFile(homePath, input.path);
    case "files.write": return writeAppFile(homePath, input, guard);
    case "files.mkdir": return mkdirAppFile(homePath, input.path, guard);
  }
}

/**
 * `POST /` of the app file bridge, mounted at `APP_FILES_BRIDGE_PATH`. Order:
 * configuration, owner, global in-flight limit, body limit, schema, the
 * app's own rate and in-flight budget plus the global rate ceiling, app
 * access, then path resolution inside the operation.
 */
export function createAppFileRoutes(options: AppFileRouteOptions): Hono {
  const routes = new Hono();
  const budget = createAppFileAdmission();
  // A single-owner host may record the owner's projects under any of its
  // accepted identities, so a write is fenced by the projects of every one,
  // not only the identity this request came in as.
  const writeGuard: ProjectWriteGuard = options.projectPathAdmission
    ? createProjectWriteGuard(options.projectPathAdmission, options.ownerIds)
    : unguardedProjectWrite;

  const admission: MiddlewareHandler = async (context, next) => {
    if (!options.homePath) {
      console.warn("[app-files] no home path configured");
      return fail(context, "unavailable");
    }
    let owner: string | null;
    try { owner = options.resolveOwner(context); }
    catch (error: unknown) {
      console.warn("[app-files] principal unavailable", error instanceof Error ? error.name : "UnknownError");
      return fail(context, "forbidden");
    }
    if (!owner || !options.ownerIds.includes(owner)) return fail(context, "forbidden");
    const release = budget.enter();
    if (!release) return fail(context, "unavailable");
    try { await next(); }
    finally { release(); }
  };

  routes.post(
    "/",
    admission,
    bodyLimit({ maxSize: MAX_APP_FILE_REQUEST_BYTES, onError: (context) => fail(context, "too_large") }),
    async (context) => {
      const homePath = options.homePath as string;
      let body: unknown;
      try { body = await context.req.json(); }
      catch (error: unknown) {
        if (error instanceof Error && error.name === "BodyLimitError") return fail(context, "too_large");
        if (!(error instanceof SyntaxError)) logAppFileFailure("body", error);
        return fail(context, "invalid_request");
      }
      if (oversizedWrite(body)) return fail(context, "too_large");
      const parsed = AppFileRequestSchema.safeParse(body);
      if (!parsed.success) return fail(context, "invalid_request");
      const { app, input } = parsed.data;
      const releaseApp = budget.admitApp(app);
      if (!releaseApp) return fail(context, "unavailable");
      try {
        if (!await appFilesAllowed(homePath, app)) throw new AppFileError("forbidden");
        return context.json(await runOperation(homePath, input, writeGuard), 200);
      } catch (error: unknown) {
        logAppFileFailure(input.kind, error);
        return fail(context, appFileErrorCodeFor(error));
      } finally { releaseApp(); }
    },
  );
  return routes;
}
