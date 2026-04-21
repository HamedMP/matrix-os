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

export interface SafeBuildEnvOptions {
  storeDir?: string;
}

// MATRIX_AUTH_TOKEN is the HKDF master key used by deriveAppSessionKey; a
// postinstall script or Vite plugin that reads it could forge cookies for any
// slug. NODE_OPTIONS is blocked because --inspect / --require lets a child
// process escalate into the gateway's debugger.
const EXPLICIT_BUILD_DENY = new Set([
  "MATRIX_AUTH_TOKEN",
  "DATABASE_URL",
  "NODE_OPTIONS",
]);

// Anchored on `(^|_)` so NEXT_PUBLIC_*_PUBLISHABLE_KEY and other vars ending in
// plain `_KEY` are intentionally not matched.
const SECRET_SUFFIX_RE = /(^|_)(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SECRET_KEY)$/i;

// Denylist (not allowlist like safeEnv): builds need the surrounding tool
// ecosystem — XDG dirs, npm_config_*, TMPDIR, locale, proxy config — so we
// start from process.env and strip known-sensitive keys.
export function safeBuildEnv(opts: SafeBuildEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (EXPLICIT_BUILD_DENY.has(k)) continue;
    if (SECRET_SUFFIX_RE.test(k)) continue;
    env[k] = v;
  }
  env.NODE_ENV = "production";
  if (opts.storeDir) {
    env.npm_config_store_dir = opts.storeDir;
  }
  return env;
}
