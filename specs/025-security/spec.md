# 025: Security Hardening

## Problem

Matrix OS currently has minimal security: a single bearer token for gateway auth and a safe-mode agent for diagnostics. With multi-tenant cloud deployment (Phase 008B) and channel adapters exposing the kernel to untrusted external input, the attack surface is growing. There is no protection against prompt injection from external content, no SSRF guards on outbound fetches, no sandbox isolation for agent code execution, no security audit tooling, and no crash-recovery for outbound messages.

## Solution

Defense-in-depth security inspired by Moltbot's battle-tested patterns, rebuilt for Matrix OS's file-centric architecture. Six layers: (1) external content wrapping with prompt injection markers, (2) SSRF guard on all outbound HTTP, (3) gateway tool deny list and rate limiting, (4) config env-ref preservation to prevent secret leakage, (5) optional Docker sandbox per session, (6) security audit CLI with typed findings. Plus a write-ahead outbound queue for crash-recovery.

## Design

### External Content Wrapping

All untrusted content (channel messages, webhooks, web fetch, web search, browser snapshots) is wrapped before injection into the LLM context:

```typescript
type ExternalContentSource =
  | "channel" | "webhook" | "web_fetch" | "web_search"
  | "browser" | "email" | "api" | "unknown";

interface WrapOptions {
  source: ExternalContentSource;
  from?: string;       // sender identity
  subject?: string;    // email/webhook subject
  includeWarning?: boolean;  // prepend security notice (default: true for web_fetch, browser)
}

function wrapExternalContent(content: string, opts: WrapOptions): string;
function sanitizeMarkers(content: string): string;  // strip/replace injection markers + homoglyphs
function detectSuspiciousPatterns(content: string): { suspicious: boolean; patterns: string[] };
```

Output format:
```
<<<EXTERNAL_UNTRUSTED_CONTENT>>>
Source: web_fetch
URL: https://example.com
---
[sanitized content]
<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>
```

### SSRF Guard

```typescript
interface SsrfGuardOptions {
  allowPrivateNetwork?: boolean;      // default: false
  allowedHostnames?: string[];        // whitelist (supports wildcards: *.example.com)
}

function fetchWithSsrfGuard(url: string, init?: RequestInit, opts?: SsrfGuardOptions): Promise<Response>;
// DNS pre-flight: resolve hostname, block private IPv4/IPv6, loopback, link-local, metadata endpoints
```

### Gateway Security

```typescript
// Hard-coded deny list for /api/tools/invoke (defense in depth, separate from user policy)
const GATEWAY_TOOL_DENY = [
  "spawn_agent",        // remote code execution risk
  "manage_cron",        // scheduled task manipulation
  "sync_files",         // file sync manipulation
] as const;

// Rate limiter
interface RateLimitConfig {
  maxAttempts: number;   // default: 10
  windowMs: number;      // default: 60_000
  lockoutMs: number;     // default: 300_000
}
```

### Config Env-Ref Preservation

```typescript
// When writing config, restore ${VAR} references instead of baking in resolved values
function restoreEnvVarRefs(
  resolved: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown>;
```

### Security Audit

```typescript
interface SecurityAuditFinding {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
}

interface SecurityAuditReport {
  timestamp: string;
  findings: SecurityAuditFinding[];
  summary: { info: number; warn: number; critical: number };
}

// Checks: file permissions, gateway bind, auth token strength, rate limiting,
// secrets in config, sandbox config, channel exposure, exec allowlist
function runSecurityAudit(home: string, config: Config): Promise<SecurityAuditReport>;
```

### Outbound Write-Ahead Queue

```typescript
interface OutboundMessage {
  id: string;
  channel: string;
  target: string;
  content: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

// Persists to ~/system/outbound-queue.json. On gateway restart, replays undelivered messages.
class OutboundQueue {
  enqueue(msg: Omit<OutboundMessage, "id" | "createdAt" | "attempts">): string;
  ack(id: string): void;
  replay(): Promise<void>;  // called on gateway start
  failed(id: string, error: string): void;
}
```

### Docker Sandbox (Optional)

```typescript
interface SandboxConfig {
  mode: "off" | "subagents" | "all";   // subagents = only sub-agents sandboxed
  workspaceAccess: "none" | "ro" | "rw";
  idleTimeoutMs: number;               // auto-stop idle containers
  image: string;                        // default: "matrixos/sandbox:latest"
}
```

## Dependencies

- Phase 008B (multi-tenant platform) -- complete
- Phase 006 (channels) -- complete
- Phase 007 (cron/heartbeat) -- complete

## File Locations

```
packages/kernel/src/
  security/
    external-content.ts   # wrapExternalContent, sanitizeMarkers, detectSuspiciousPatterns
    ssrf-guard.ts          # fetchWithSsrfGuard, DNS pre-flight
    audit.ts               # runSecurityAudit, SecurityAuditReport
packages/gateway/src/
  security/
    rate-limiter.ts        # RateLimiter, per-IP tracking
    tool-deny.ts           # GATEWAY_TOOL_DENY list, policy filter
    outbound-queue.ts      # OutboundQueue, write-ahead persistence
  auth.ts                  # existing -- add rate limiting, timing-safe comparison
  config/
    env-preserve.ts        # restoreEnvVarRefs
packages/kernel/src/
  sandbox/
    manager.ts             # SandboxManager (dockerode)
    config.ts              # SandboxConfig schema
tests/
  security/
    external-content.test.ts
    ssrf-guard.test.ts
    audit.test.ts
    rate-limiter.test.ts
    outbound-queue.test.ts
    env-preserve.test.ts
    sandbox.test.ts
```
