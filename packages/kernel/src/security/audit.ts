import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SecurityAuditFinding {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}

export interface SecurityAuditReport {
  timestamp: string;
  findings: SecurityAuditFinding[];
  summary: { info: number; warn: number; critical: number };
}

const SECRET_PATTERNS = [
  /^sk-ant-/,
  /^sk-[a-zA-Z0-9]{20,}/,
  /^ghp_/,
  /^gho_/,
  /^xoxb-/,
  /^xoxp-/,
];

const ENV_REF_PATTERN = /^\$\{.+\}$/;

export async function runSecurityAudit(homePath: string): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const configPath = join(homePath, "system/config.json");

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch { /* config may not exist */ }

  checkConfigPermissions(configPath, findings);
  checkAuthToken(config, findings);
  checkBakedSecrets(config, findings);

  const summary = {
    info: findings.filter((f) => f.severity === "info").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    critical: findings.filter((f) => f.severity === "critical").length,
  };

  return {
    timestamp: new Date().toISOString(),
    findings,
    summary,
  };
}

function checkConfigPermissions(
  configPath: string,
  findings: SecurityAuditFinding[],
) {
  try {
    const stat = statSync(configPath);
    const mode = stat.mode & 0o777;
    if (mode & 0o044) {
      findings.push({
        checkId: "config-permissions",
        severity: "warn",
        title: "Config file is world/group readable",
        detail: `config.json has permissions ${mode.toString(8)} -- should be 600`,
        remediation: "chmod 600 system/config.json",
      });
    }
  } catch { /* file doesn't exist */ }
}

function checkAuthToken(
  config: Record<string, unknown>,
  findings: SecurityAuditFinding[],
) {
  const auth = config.auth as Record<string, unknown> | undefined;
  if (!auth?.token) return;
  const token = String(auth.token);

  if (ENV_REF_PATTERN.test(token)) return;

  if (token.length < 24) {
    findings.push({
      checkId: "weak-auth-token",
      severity: "warn",
      title: "Auth token is weak",
      detail: `Token is only ${token.length} characters -- recommend at least 24`,
      remediation: "Use a longer random token: openssl rand -hex 24",
    });
  }
}

function checkBakedSecrets(
  config: Record<string, unknown>,
  findings: SecurityAuditFinding[],
) {
  walkValues(config, (value, path) => {
    if (typeof value !== "string") return;
    if (ENV_REF_PATTERN.test(value)) return;

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({
          checkId: "baked-secret",
          severity: "critical",
          title: "Secret baked into config",
          detail: `${path} contains what looks like a secret (matches ${pattern})`,
          remediation: `Replace with \${ENV_VAR} reference: ${path}: "\${YOUR_SECRET}"`,
        });
        return;
      }
    }
  });
}

function walkValues(
  obj: Record<string, unknown>,
  cb: (value: unknown, path: string) => void,
  prefix = "",
) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      walkValues(value as Record<string, unknown>, cb, path);
    } else {
      cb(value, path);
    }
  }
}
