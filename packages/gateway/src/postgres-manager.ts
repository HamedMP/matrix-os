import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface PostgresConfig {
  homePath: string;
  port?: number;
  dataDir?: string;
}

export interface AppDatabaseInfo {
  database: string;
  role: string;
  password: string;
}

export interface PostgresStatus {
  active: boolean;
  port: number;
  databases: string[];
}

export interface PostgresManager {
  activate(): Promise<void>;
  deactivate(): void;
  status(): PostgresStatus;
  createAppDatabase(appName: string): Promise<AppDatabaseInfo>;
  getConnectionString(appName: string): string;
}

const SAFE_APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function sanitizeForPg(appName: string): string {
  return appName.replace(/-/g, "_");
}

function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** @deprecated Use AppDb schema-per-app model (app-db.ts + app-db-registry.ts) instead. Will be removed in v0.6.0. */
export function createPostgresManager(config: PostgresConfig): PostgresManager {
  const { homePath, port = 5432 } = config;
  const credentialsPath = join(homePath, "system", "postgres", "credentials.json");

  let active = false;
  let credentials: Record<string, AppDatabaseInfo> = {};

  function loadCredentials(): void {
    if (existsSync(credentialsPath)) {
      try {
        credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
      } catch {
        credentials = {};
      }
    }
  }

  function saveCredentials(): void {
    const dir = join(homePath, "system", "postgres");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  }

  function validateAppName(appName: string): void {
    if (!appName || !SAFE_APP_NAME.test(appName)) {
      throw new Error(`Invalid app name: ${appName}`);
    }
    if (appName.includes("..") || appName.includes("/") || appName.includes("\\")) {
      throw new Error(`Invalid app name: ${appName}`);
    }
  }

  loadCredentials();

  return {
    async activate(): Promise<void> {
      active = true;
      loadCredentials();
    },

    deactivate(): void {
      active = false;
    },

    status(): PostgresStatus {
      return {
        active,
        port,
        databases: Object.values(credentials).map((c) => c.database),
      };
    },

    async createAppDatabase(appName: string): Promise<AppDatabaseInfo> {
      validateAppName(appName);

      if (!active) {
        throw new Error("PostgreSQL is not active. Call activate() first.");
      }

      if (credentials[appName]) {
        return credentials[appName];
      }

      const sanitized = sanitizeForPg(appName);
      const info: AppDatabaseInfo = {
        database: `${sanitized}_db`,
        role: `app_${sanitized}`,
        password: generatePassword(),
      };

      credentials[appName] = info;
      saveCredentials();

      return info;
    },

    getConnectionString(appName: string): string {
      const info = credentials[appName];
      if (!info) {
        throw new Error(`No database provisioned for app: ${appName}`);
      }
      return `postgresql://${info.role}:${info.password}@localhost:${port}/${info.database}`;
    },
  };
}
