import { AppIntegrationAppSchema, AppIntegrationInputSchema } from "@matrix-os/contracts";

/** Parent binds the verified iframe identity, never accepting an app/actor from its payload. */
export function prepareAppIntegrationRequest(app: string, url: string, init: RequestInit): { url: string; init: RequestInit } {
  const identity = AppIntegrationAppSchema.parse(app);
  if (url !== "/api/bridge/integrations") throw new Error("Invalid app integration request");
  if (!init.method || init.method === "GET") {
    if (init.body !== undefined) throw new Error("Invalid app integration request");
    return { url: `${url}?app=${encodeURIComponent(identity)}`, init: { method: "GET" } };
  }
  if (init.method !== "POST" || typeof init.body !== "string" || init.body.length > 65_536) throw new Error("Invalid app integration request");
  const input = AppIntegrationInputSchema.parse(JSON.parse(init.body));
  return { url, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: identity, ...input }) } };
}
