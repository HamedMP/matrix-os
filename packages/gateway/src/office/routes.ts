import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod/v4";
import {
  OFFICE_DOCUMENTS_BASE_PATH, OFFICE_DOCUMENT_BUDGET_HEADER, OFFICE_DOCUMENT_ERROR_STATUS, OFFICE_DOCUMENT_MAX_BUDGET_MS,
  OFFICE_DOCUMENT_REQUEST_MAX_BYTES, OFFICE_DOCUMENT_ROUTES as R, OfficeDocumentBudgetHeaderSchema,
  DocumentAddCommentRequestSchema, DocumentCompareRequestSchema, DocumentCreateRequestSchema, DocumentDescribeRequestSchema,
  DocumentPathRequestSchema, DocumentProposeEditsRequestSchema, DocumentReadTextRequestSchema,
  DocumentResolveRevisionsRequestSchema, SheetDescribeRequestSchema, SheetPathRequestSchema, SheetProposeEditsRequestSchema,
  SheetReadRangeRequestSchema, SheetResolveChangesRequestSchema, officeDocumentErrorBody,
  type OfficeDocumentErrorCode,
} from "@matrix-os/contracts/office-documents";
import { createProjectWriteGuard } from "../app-files/project-write-fence.js";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { readPrincipalRuntimeConfig } from "../request-principal.js";
import { OfficeDeadline } from "./deadline.js";
import type { OfficeEngine } from "./engine-pool.js";
import { logOfficeFailure, officeErrorCodeFor } from "./errors.js";
import { OfficeDocumentService } from "./service.js";

export interface OfficeDocumentRouteOptions {
  /** Owner home. Empty or missing means misconfiguration: every request answers 503. */
  homePath: string | null | undefined;
  clock?: () => Date;
  maxFileBytes?: number;
  /** Engine runs that may be in flight at once; more answer 503 `busy`. */
  maxInFlight?: number;
  /** Test seam: runs right before a save's version check. */
  beforeCommit?: (absolutePath: string) => Promise<void>;
  /** Where the engine runs. Defaults to the gateway's shared pool of engine threads. */
  engine?: OfficeEngine;
  /**
   * The collaboration fence of the owner file routes. With it, a save into a
   * shared or mid-transition project is refused; without it (no collaboration
   * database) every save is admitted.
   */
  projectPathAdmission?: LegacyProjectPathAdmission;
  /**
   * Every identity the gateway's owner may hold projects under. Agent tools
   * call this service in process, with no request principal, so the fence is
   * asked for each of them. Required with `projectPathAdmission`; empty fails closed.
   */
  ownerIds?: readonly string[];
}

export const OFFICE_DOCUMENT_MAX_IN_FLIGHT = 8;

/**
 * The identities to ask the project fence for on this gateway: the VPS owner
 * (`MATRIX_USER_ID`, or `MATRIX_CLERK_USER_ID` on hosts provisioned before it
 * existed), or the development principal where requests carry no owner.
 */
export function officeFenceOwnerIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [env.MATRIX_USER_ID, env.MATRIX_CLERK_USER_ID].filter((id): id is string => Boolean(id));
  if (configured.length > 0) return [...new Set(configured)];
  const principal = readPrincipalRuntimeConfig(env);
  const development = principal.isLocalDevelopment && !principal.authEnabled && !principal.isProduction;
  return development ? [principal.devDefaultUserId] : [];
}

function fail(c: Context, code: OfficeDocumentErrorCode): Response {
  return c.json(officeDocumentErrorBody(code), OFFICE_DOCUMENT_ERROR_STATUS[code]);
}

type Handler<S extends z.ZodType> = (service: OfficeDocumentService, input: z.output<S>, deadline: OfficeDeadline) => Promise<unknown>;

/**
 * `/api/office/*`: the document service for agents. Mount behind the gateway
 * auth middleware. Every route is a POST with a JSON body, a body limit, a
 * strict schema, and generic client errors; details are logged. The request's
 * deadline starts when it arrives: the caller's budget header, at most
 * {@link OFFICE_DOCUMENT_MAX_BUDGET_MS}, ended early if the caller disconnects.
 */
export function createOfficeDocumentRoutes(options: OfficeDocumentRouteOptions): Hono {
  const routes = new Hono();
  const service = options.homePath
    ? new OfficeDocumentService({
        homePath: options.homePath,
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.maxFileBytes ? { maxFileBytes: options.maxFileBytes } : {}),
        ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
        ...(options.engine ? { engine: options.engine } : {}),
        ...(options.projectPathAdmission
          ? { writeGuard: createProjectWriteGuard(options.projectPathAdmission, options.ownerIds ?? []) }
          : {}),
      })
    : null;
  const maxInFlight = options.maxInFlight ?? OFFICE_DOCUMENT_MAX_IN_FLIGHT;
  let inFlight = 0;
  const limit = bodyLimit({ maxSize: OFFICE_DOCUMENT_REQUEST_MAX_BYTES, onError: (c) => fail(c, "too_large") });

  function post<S extends z.ZodType>(route: string, schema: S, handler: Handler<S>): void {
    routes.post(route, limit, async (c) => {
      const header = c.req.header(OFFICE_DOCUMENT_BUDGET_HEADER);
      const budget = header === undefined ? null : OfficeDocumentBudgetHeaderSchema.safeParse(header);
      if (budget && !budget.success) return fail(c, "invalid_request");
      const deadline = OfficeDeadline.after(budget?.data ?? OFFICE_DOCUMENT_MAX_BUDGET_MS, c.req.raw.signal);
      if (!service) return fail(c, "unavailable");
      let raw: unknown;
      try { raw = JSON.parse(await c.req.text()); }
      catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        return fail(c, "invalid_request");
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return fail(c, "invalid_request");
      if (inFlight >= maxInFlight) return fail(c, "busy");
      inFlight++;
      try {
        return c.json(await handler(service, parsed.data, deadline) as object, 200);
      } catch (error: unknown) {
        const code = officeErrorCodeFor(error);
        logOfficeFailure(route, code, error);
        return fail(c, code);
      } finally {
        inFlight--;
      }
    });
  }

  post(R.documentDescribe, DocumentDescribeRequestSchema, (s, input, deadline) => s.describeDocument(input, deadline));
  post(R.documentReadText, DocumentReadTextRequestSchema, (s, input, deadline) => s.readDocumentText(input, deadline));
  post(R.documentProposeEdits, DocumentProposeEditsRequestSchema, (s, input, deadline) => s.proposeDocumentEdits(input, deadline));
  post(R.documentRevisionsList, DocumentPathRequestSchema, (s, input, deadline) => s.listDocumentRevisions(input, deadline));
  post(R.documentRevisionsAccept, DocumentResolveRevisionsRequestSchema, (s, input, deadline) => s.resolveDocumentRevisions(input, true, deadline));
  post(R.documentRevisionsReject, DocumentResolveRevisionsRequestSchema, (s, input, deadline) => s.resolveDocumentRevisions(input, false, deadline));
  post(R.documentCommentsAdd, DocumentAddCommentRequestSchema, (s, input, deadline) => s.addDocumentComment(input, deadline));
  post(R.documentCompare, DocumentCompareRequestSchema, (s, input, deadline) => s.compareDocuments(input, deadline));
  post(R.documentCreate, DocumentCreateRequestSchema, (s, input, deadline) => s.createDocument(input, deadline));
  post(R.sheetDescribe, SheetDescribeRequestSchema, (s, input, deadline) => s.describeSheet(input, deadline));
  post(R.sheetReadRange, SheetReadRangeRequestSchema, (s, input, deadline) => s.readSheetRange(input, deadline));
  post(R.sheetProposeEdits, SheetProposeEditsRequestSchema, (s, input, deadline) => s.proposeSheetEdits(input, deadline));
  post(R.sheetChangesList, SheetPathRequestSchema, (s, input, deadline) => s.listSheetChanges(input, deadline));
  post(R.sheetChangesAccept, SheetResolveChangesRequestSchema, (s, input, deadline) => s.resolveSheetChanges(input, true, deadline));
  post(R.sheetChangesReject, SheetResolveChangesRequestSchema, (s, input, deadline) => s.resolveSheetChanges(input, false, deadline));
  return routes;
}

/**
 * Mounts the document service at `/api/office`. Pass the instance the kernel
 * document tools already use, so HTTP callers and agent tools share one
 * service (one per-path lock, one in-flight cap); with options, a service is
 * built here, once, at registration.
 */
export function registerOfficeDocumentRoutes(app: Hono, routesOrOptions: Hono | OfficeDocumentRouteOptions): void {
  app.route(OFFICE_DOCUMENTS_BASE_PATH, routesOrOptions instanceof Hono ? routesOrOptions : createOfficeDocumentRoutes(routesOrOptions));
}
