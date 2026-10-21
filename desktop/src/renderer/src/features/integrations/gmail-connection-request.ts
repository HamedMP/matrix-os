import { GmailConnectionOptionsSchema, type GmailConnectionOptions } from "@matrix-os/contracts/integration-marketplace";
import { AppError } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";

export async function fetchGmailConnectionOptions(api: ApiClient | null): Promise<GmailConnectionOptions> {
  if (!api) throw new AppError("misconfigured");
  try {
    return GmailConnectionOptionsSchema.parse(await api.get<unknown>("/api/integrations/gmail/connection-options"));
  } catch (error) {
    if (error instanceof AppError && error.category === "notFound") return { methods: ["pipedream"], defaultMethod: "pipedream" };
    throw new AppError("server");
  }
}
