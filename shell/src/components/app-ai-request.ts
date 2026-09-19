import { AppAiInputSchema } from "@matrix-os/contracts";

/** Bind identity in the trusted parent, never trust an iframe's body app field. */
export function prepareAppAiRequest(app: string, init: RequestInit): RequestInit {
  if (init.method !== "POST" || typeof init.body !== "string" || init.body.length > 65_536) {
    throw new Error("Invalid app AI request");
  }
  const input = AppAiInputSchema.parse(JSON.parse(init.body));
  return {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app, ...input }),
  };
}
