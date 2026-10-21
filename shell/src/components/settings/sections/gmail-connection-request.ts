import { GmailConnectionOptionsSchema, type GmailConnectionOptions } from "@matrix-os/contracts/integration-marketplace";

export async function fetchGmailConnectionOptions(gateway: string): Promise<GmailConnectionOptions> {
  const response = await fetch(`${gateway}/api/integrations/gmail/connection-options`, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return { methods: ["pipedream"], defaultMethod: "pipedream" };
  if (!response.ok) throw new Error("Gmail connection options unavailable");
  return GmailConnectionOptionsSchema.parse(await response.json());
}
