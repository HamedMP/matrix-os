import { type Kysely } from 'kysely';
import type { GalleryDatabase } from './types.js';

export interface AuditFinding {
  layer: 'manifest' | 'static' | 'sandbox';
  severity: 'error' | 'warning';
  rule: string;
  message: string;
  file: string | null;
  line: number | null;
}

const ALLOWED_PERMISSIONS = new Set([
  'fs.read', 'fs.write', 'net.fetch', 'net.listen',
  'db.read', 'db.write', 'env.read', 'clipboard.read',
  'clipboard.write', 'notifications', 'camera', 'microphone',
]);

const SANDBOXABLE_PERMISSIONS = new Set([
  'fs.read', 'fs.write', 'net.fetch', 'net.listen',
  'db.read', 'db.write', 'clipboard.read', 'clipboard.write',
  'notifications', 'camera', 'microphone', 'env.read',
]);

const HIGH_RISK_COMBOS: Array<{ permissions: string[]; message: string }> = [
  {
    permissions: ['fs.write', 'net.fetch'],
    message: 'Can write files and make network requests -- potential data exfiltration risk',
  },
  {
    permissions: ['env.read', 'net.fetch'],
    message: 'Can read environment variables and make network requests -- potential credential leak',
  },
];

// Static analysis patterns
interface ScanRule {
  rule: string;
  pattern: RegExp;
  severity: 'error' | 'warning';
  message: string;
  extensions?: string[];
}

const SCAN_RULES: ScanRule[] = [
  {
    rule: 'path-traversal',
    pattern: /\.\.\//,
    severity: 'error',
    message: 'Path traversal pattern detected (../)',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
  {
    rule: 'env-access',
    pattern: /process\.env\b/,
    severity: 'error',
    message: 'Direct process.env access -- use declared permissions instead',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
  {
    rule: 'dynamic-code',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    severity: 'error',
    message: 'Dynamic code execution detected (eval or Function constructor)',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
  {
    rule: 'child-process',
    pattern: /child_process|require\s*\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/,
    severity: 'error',
    message: 'Child process usage detected -- not allowed in sandboxed apps',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
  {
    rule: 'fs-outside-sandbox',
    pattern: /require\s*\(\s*['"]fs['"]\s*\)|from\s+['"]fs['"]|from\s+['"]node:fs['"]/,
    severity: 'warning',
    message: 'Direct fs module import -- use the sandbox file API instead',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'],
  },
];

// Layer 1: Manifest audit
export function auditManifest(manifest: Record<string, unknown>): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (!manifest.name) {
    findings.push({
      layer: 'manifest',
      severity: 'error',
      rule: 'missing-name',
      message: 'Manifest must include a name',
      file: 'matrix.json',
      line: null,
    });
  }

  const permissions = (manifest.permissions as string[]) ?? [];
  for (const perm of permissions) {
    if (!ALLOWED_PERMISSIONS.has(perm)) {
      findings.push({
        layer: 'manifest',
        severity: 'error',
        rule: 'unknown-permission',
        message: `Unknown permission: "${perm}". Allowed: ${[...ALLOWED_PERMISSIONS].join(', ')}`,
        file: 'matrix.json',
        line: null,
      });
    }
  }

  const integrations = manifest.integrations as { required?: string[]; optional?: string[] } | undefined;
  if (integrations?.required?.length) {
    for (const req of integrations.required) {
      findings.push({
        layer: 'manifest',
        severity: 'warning',
        rule: 'required-integration',
        message: `Requires integration: "${req}" -- users must configure this before use`,
        file: 'matrix.json',
        line: null,
      });
    }
  }

  return findings;
}

// Layer 2: Static code scan
export function auditStaticCode(files: Map<string, string>): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const [filePath, content] of files) {
    const ext = '.' + filePath.split('.').pop();

    for (const rule of SCAN_RULES) {
      if (rule.extensions && !rule.extensions.includes(ext)) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          findings.push({
            layer: 'static',
            severity: rule.severity,
            rule: rule.rule,
            message: rule.message,
            file: filePath,
            line: i + 1,
          });
        }
      }
    }
  }

  return findings;
}

// Layer 3: Sandbox policy
export function auditSandboxPolicy(permissions: string[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const perm of permissions) {
    if (!SANDBOXABLE_PERMISSIONS.has(perm)) {
      findings.push({
        layer: 'sandbox',
        severity: 'error',
        rule: 'unsandboxable-permission',
        message: `Permission "${perm}" cannot be enforced within the sandbox`,
        file: null,
        line: null,
      });
    }
  }

  for (const combo of HIGH_RISK_COMBOS) {
    if (combo.permissions.every((p) => permissions.includes(p))) {
      findings.push({
        layer: 'sandbox',
        severity: 'warning',
        rule: 'high-risk-combo',
        message: combo.message,
        file: null,
        line: null,
      });
    }
  }

  return findings;
}

interface AuditInput {
  manifest: Record<string, unknown>;
  files: Map<string, string>;
}

interface AuditResult {
  id: string;
  status: 'passed' | 'failed';
  manifestFindings: AuditFinding[];
  staticFindings: AuditFinding[];
  sandboxFindings: AuditFinding[];
}

export async function runFullAudit(
  db: Kysely<GalleryDatabase>,
  versionId: string,
  input: AuditInput,
): Promise<AuditResult> {
  const startedAt = new Date();

  // Run all 3 layers
  const manifestFindings = auditManifest(input.manifest);
  const staticFindings = auditStaticCode(input.files);
  const permissions = (input.manifest.permissions as string[]) ?? [];
  const sandboxFindings = auditSandboxPolicy(permissions);

  // Determine overall status: any error finding = failed
  const allFindings = [...manifestFindings, ...staticFindings, ...sandboxFindings];
  const hasErrors = allFindings.some((f) => f.severity === 'error');
  const status = hasErrors ? 'failed' : 'passed';

  const completedAt = new Date();

  // Write audit record
  const audit = await db.insertInto('security_audits')
    .values({
      version_id: versionId,
      status,
      manifest_findings: JSON.stringify(manifestFindings),
      static_findings: JSON.stringify(staticFindings),
      sandbox_findings: JSON.stringify(sandboxFindings),
      started_at: startedAt,
      completed_at: completedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // Update version audit status
  await db.updateTable('app_versions')
    .set({
      audit_status: status,
      audit_findings: JSON.stringify(allFindings),
    })
    .where('id', '=', versionId)
    .execute();

  return {
    id: audit.id,
    status: status as 'passed' | 'failed',
    manifestFindings,
    staticFindings,
    sandboxFindings,
  };
}

export async function getLatestAudit(
  db: Kysely<GalleryDatabase>,
  versionId: string,
) {
  const result = await db.selectFrom('security_audits')
    .selectAll()
    .where('version_id', '=', versionId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();

  return result ?? null;
}
