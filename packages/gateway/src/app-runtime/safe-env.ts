import { join } from "node:path";

export interface SafeEnvOptions {
  slug: string;
  port: number;
  homeDir: string;
}

const MINIMAL_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export function safeEnv(opts: SafeEnvOptions): Record<string, string> {
  const { slug, port, homeDir } = opts;

  return {
    PORT: String(port),
    NODE_ENV: "production",
    HOME: join(homeDir, "apps", slug),
    PATH: MINIMAL_PATH,
    MATRIX_APP_SLUG: slug,
    MATRIX_APP_DATA_DIR: join(homeDir, "data", slug),
    MATRIX_GATEWAY_URL: "http://127.0.0.1:4000",
  };
}
