import { createHash } from "node:crypto";
import { join } from "node:path";

/** Stable, path-safe local storage names for one authenticated Matrix account. */
export function browserAccountScope(userId: string): { partition: string; vaultDirectory: string } {
  if (!userId || userId.length > 512) throw new Error("browser account unavailable");
  const digest = createHash("sha256").update(userId).digest("hex");
  return {
    partition: `persist:browser-${digest}`,
    vaultDirectory: join("browser-accounts", digest),
  };
}
