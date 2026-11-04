export type ClientErrorProperties = Record<string, string | number | boolean | undefined>;

interface ClientErrorReportContext {
  buildSha?: string;
  path: string;
  userAgent: string;
}

export function buildClientErrorReport(
  error: unknown,
  properties: ClientErrorProperties,
  context: ClientErrorReportContext,
) {
  return {
    errorId: typeof properties.errorId === "string" ? properties.errorId : undefined,
    source: typeof properties.source === "string" ? properties.source : undefined,
    digest: typeof properties.digest === "string" ? properties.digest : undefined,
    staleBundleFingerprint: typeof properties.staleBundleFingerprint === "string"
      ? properties.staleBundleFingerprint.slice(0, 128)
      : undefined,
    name: error instanceof Error ? error.name : typeof error,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    stack: error instanceof Error ? error.stack?.slice(0, 4_000) : undefined,
    path: context.path.slice(0, 512),
    userAgent: context.userAgent.slice(0, 512),
    buildSha: context.buildSha,
  };
}
