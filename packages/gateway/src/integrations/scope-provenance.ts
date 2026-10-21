/** Gateway overwrites this marker after bearer validation; Platform uses it only to narrow catalog output. */
export const INTEGRATION_READ_SCOPE_HEADER = "x-matrix-integration-read-scope";

/** Read authority is derived from the verified Run context, never caller headers. */
export function hasIntegrationReadScope(run: { scope?: string; integrationRead?: boolean } | undefined): boolean {
  return run?.scope === "integration_read" || run?.integrationRead === true;
}
