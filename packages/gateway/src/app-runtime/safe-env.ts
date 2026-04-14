import { join, dirname } from "node:path";

export interface SafeEnvOptions {
  slug: string;
  port: number;
  homeDir: string;
}

const SYSTEM_PATHS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];

// Resolve the directory containing the current Node.js binary so child
// processes can find `node` even when it lives in a non-standard location
// (e.g., fnm, nvm, volta, mise). This is computed once at module load.
const NODE_BIN_DIR = dirname(process.execPath);

function buildMinimalPath(): string {
  const parts = [...SYSTEM_PATHS];
  // Prepend node's bin dir if it is not already in the system paths
  if (!parts.includes(NODE_BIN_DIR)) {
    parts.unshift(NODE_BIN_DIR);
  }
  return parts.join(":");
}

const MINIMAL_PATH = buildMinimalPath();

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
