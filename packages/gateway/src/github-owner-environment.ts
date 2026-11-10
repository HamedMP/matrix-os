import { join } from "node:path";

/** GitHub development uses owner files, never a gateway token or injected Git routing. */
export function githubOwnerEnvironment(homePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
    "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
  ]) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  return {
    ...env,
    HOME: homePath,
    MATRIX_HOME: homePath,
    XDG_CONFIG_HOME: join(homePath, ".config"),
    GH_CONFIG_DIR: join(homePath, ".config", "gh"),
    GH_HOST: "github.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(homePath, ".gitconfig"),
  };
}
