import type { Hono } from "hono";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { createGatewayAppFileProjectPathAdmission, type createGatewayProjectPathAdmission } from "../server/project-routes.js";
import { closeSharedOfficeEngine } from "./engine-pool.js";
import { createOfficeDocumentRoutes, officeFenceOwnerIds } from "./routes.js";

type AdmissionOptions = Parameters<typeof createGatewayProjectPathAdmission>[0];

export interface GatewayOfficeDocuments {
  /** One document service for the kernel tools and the `/api/office` routes: one per-path lock. */
  routes: Hono;
  /**
   * The project write fence for document saves, undefined without a
   * collaboration database. The app file bridge takes the same instance. It
   * matches paths without synchronous filesystem calls; the saves themselves
   * resolve paths asynchronously inside the held admission.
   */
  projectPathAdmission: LegacyProjectPathAdmission | undefined;
  /** Ends the document engine threads. Call on gateway shutdown; never rejects. */
  close(): Promise<void>;
}

/**
 * Builds the gateway's document service at startup. Saves run inside the
 * collaboration project fence for every identity of the gateway's owner,
 * because agent tools call the service in process, with no request principal.
 */
export function createGatewayOfficeDocuments(options: AdmissionOptions): GatewayOfficeDocuments {
  const projectPathAdmission = createGatewayAppFileProjectPathAdmission(options);
  return {
    routes: createOfficeDocumentRoutes({
      homePath: options.homePath,
      ...(projectPathAdmission ? { projectPathAdmission, ownerIds: officeFenceOwnerIds() } : {}),
    }),
    projectPathAdmission,
    close: closeSharedOfficeEngine,
  };
}
