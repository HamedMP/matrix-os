import { SitePublishRequestSchema, SiteMetadataSchema, SitePublishingSchema, SiteRecordSchema, SiteSubmissionsResponseSchema, type SiteRecord, type SitePublishing, type SiteSubmission, type SiteSubmissionsResponse } from "@matrix-os/contracts";

export interface SiteMetadata { title: string; description: string; slug: string | null; baseRevision?: number }
export type { SiteSubmission };
export type SiteSubmissionsPage = SiteSubmissionsResponse;
export interface SitePublishMetadata extends SiteMetadata { reviewedConfig: SitePublishing }
export interface SiteClient {
  get(app: string, signal: AbortSignal): Promise<SiteRecord | null>;
  deploy(app: string, metadata: SitePublishMetadata, signal: AbortSignal): Promise<SiteRecord>;
  update(app: string, metadata: SiteMetadata, signal: AbortSignal): Promise<SiteRecord>;
  rollback(app: string, value: { versionId: string; baseRevision: number }, signal: AbortSignal): Promise<SiteRecord>;
  unpublish(app: string, revision: number, signal: AbortSignal): Promise<SiteRecord>;
  getConfig(app: string, signal: AbortSignal): Promise<SitePublishing>;
  submissions(app: string, cursor: string | null, signal: AbortSignal): Promise<SiteSubmissionsPage>;
  exportSubmissions(app: string, cursor: string | null, signal: AbortSignal): Promise<Blob>;
  deleteSubmission(app: string, id: string, signal: AbortSignal): Promise<void>;
}
export interface SiteTransport {
  get<T>(path: string, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<T>;
  post<T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<T>;
  patch<T>(path: string, value: unknown, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<T>;
  delete<T>(path: string, value?: unknown, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<T>;
  getBlob(path: string, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<Blob>;
  getText(path: string, options?: { signal: AbortSignal; timeoutMs?: number }): Promise<string>;
}
export class SiteClientError extends Error {
  constructor(readonly status: number) { super("Publishing request failed"); }
}
const safeMessages: Record<number, string> = {
  409: "The URL is unavailable or this publication changed. Refresh and try again.",
  413: "This app exceeds the publishing size limit.",
  429: "Too many requests. Please try again shortly.",
  503: "Publishing is unavailable. Please try again.",
};
export function siteActionError(error: unknown): string {
  const message = error instanceof SiteClientError ? safeMessages[error.status] : undefined;
  return message ?? "Could not complete this action. Please try again.";
}
const sitePath = (app: string) => `/api/apps/${encodeURIComponent(app)}/site`;
function parseSite(value: unknown, app: string): SiteRecord {
  const site = SiteRecordSchema.parse(value);
  if (site.appSlug !== app) throw new SiteClientError(503);
  return site;
}
export function createSiteClient(transport: SiteTransport): SiteClient {
  return {
    get: async (app, signal) => {
      try { const value = await transport.get<unknown>(sitePath(app), { signal }); return value === null ? null : parseSite(value, app); }
      catch (error: unknown) { if (error instanceof SiteClientError && error.status === 404) return null; throw error; }
    },
    deploy: async (app, metadata, signal) => parseSite(await transport.post(sitePath(app), SitePublishRequestSchema.parse(metadata), { signal, timeoutMs: 150_000 }), app),
    update: async (app, metadata, signal) => parseSite(await transport.patch(sitePath(app), SiteMetadataSchema.parse(metadata), { signal }), app),
    unpublish: async (app, baseRevision, signal) => parseSite(await transport.delete(sitePath(app), { baseRevision }, { signal }), app),
    rollback: async (app, value, signal) => parseSite(await transport.post(`${sitePath(app)}/rollback`, value, { signal }), app),
    getConfig: async (app, signal) => {
      const value = await transport.get<{ manifest?: { publishing?: unknown } }>(`/api/apps/${encodeURIComponent(app)}/manifest`, { signal });
      return SitePublishingSchema.parse(value.manifest?.publishing ?? { data: {}, forms: [] });
    },
    submissions: async (app, cursor, signal) => SiteSubmissionsResponseSchema.parse(await transport.get(`${sitePath(app)}/submissions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal })),
    exportSubmissions: (app, cursor, signal) => transport.getBlob(`${sitePath(app)}/submissions/export?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal }),
    deleteSubmission: async (app, id, signal) => { await transport.delete(`${sitePath(app)}/submissions/${encodeURIComponent(id)}`, undefined, { signal }); },
  };
}
