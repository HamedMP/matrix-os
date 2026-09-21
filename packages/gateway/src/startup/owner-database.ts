/**
 * Orchestrate owner Postgres startup as one transaction of process resources.
 * A partial bootstrap must release every acquired handle before the gateway
 * resumes in file storage mode; callers receive no partially usable bag.
 */
import {
  teardownOwnerDatabaseServices,
  type OwnerDatabaseFallbackServices,
  type OwnerDatabaseFallbackStep,
} from "./owner-database-fallback.js";

export interface OwnerDatabaseBootstrapOptions {
  databaseUrl?: string;
  services: OwnerDatabaseFallbackServices;
  initialize(services: OwnerDatabaseFallbackServices): Promise<void>;
  warn?(step: OwnerDatabaseFallbackStep | "OwnerDatabaseStartupFailure", error: unknown): void;
}

export interface OwnerDatabaseBootstrapResult {
  services: OwnerDatabaseFallbackServices | null;
  failureReason: "owner_database_missing" | null;
}

export async function bootOwnerDatabaseWithFallback(
  options: OwnerDatabaseBootstrapOptions,
): Promise<OwnerDatabaseBootstrapResult> {
  if (!options.databaseUrl) {
    return { services: null, failureReason: "owner_database_missing" };
  }
  try {
    await options.initialize(options.services);
    return { services: options.services, failureReason: null };
  } catch (error: unknown) {
    const warn = options.warn ?? ((step: string, cause: unknown) => {
      console.warn(`[app-db] ${step}`, cause instanceof Error ? cause.name : "UnknownError");
    });
    warn("OwnerDatabaseStartupFailure", error);
    await teardownOwnerDatabaseServices(options.services, { warn });
    return { services: null, failureReason: "owner_database_missing" };
  }
}
