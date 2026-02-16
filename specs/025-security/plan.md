# Plan: Security Hardening

**Spec**: `specs/025-security/spec.md`
**Depends on**: Phase 008B (complete), Phase 006 (complete)
**Estimated effort**: Large (20 tasks + TDD)

## Approach

Build security from the inside out. Start with the content-level defense (external content wrapping) since it protects the LLM from prompt injection -- the most critical risk. Then add network-level defense (SSRF guard). Then gateway hardening (tool deny list, rate limiting). Then operational safety (env-ref preservation, outbound queue, audit). Sandbox is last since it requires Docker and is opt-in.

### Phase A: Content Security (T820-T824)

1. External content wrapping -- marker sanitization, homoglyph detection, source-tagged wrapping
2. Suspicious pattern detection -- regex-based detection of prompt injection attempts
3. Wire wrapping into channel dispatcher (all inbound channel messages)
4. Wire wrapping into web tools (when 026-web-tools ships)

### Phase B: Network Security (T825-T829)

1. SSRF guard -- DNS pre-flight, private IP blocking, hostname allowlist
2. Wire into all outbound HTTP (fetch calls in kernel + gateway)
3. Gateway tool deny list -- hard-coded deny for dangerous IPC tools on HTTP endpoint
4. Rate limiter -- per-IP, configurable window/lockout, pluggable into auth middleware

### Phase C: Operational Security (T830-T839)

1. Config env-ref preservation -- deep structural walk, restore ${VAR} on write
2. Outbound write-ahead queue -- persist before send, ack after delivery, replay on restart
3. Auth hardening -- timing-safe token comparison, password mode option
4. Security audit -- typed findings, remediation text, severity levels, CLI runner
5. Security audit checks: file perms, gateway bind, token strength, secrets in config, exec allowlist

### Phase D: Sandbox (T840-T845)

1. Sandbox config schema + Dockerfile.sandbox
2. SandboxManager -- container lifecycle via dockerode
3. Wire into kernel spawn -- sub-agents optionally run in sandbox containers
4. Workspace bind-mount (ro/rw/none)
5. Idle container cleanup

### Phase E: Platform Auth Expansion (T800-T811)

These are the existing tasks from the original 025-security/tasks.md (Clerk JWT, WebSocket auth, container isolation, etc.). They remain as-is.

## Files to Create

- `packages/kernel/src/security/external-content.ts`
- `packages/kernel/src/security/ssrf-guard.ts`
- `packages/kernel/src/security/audit.ts`
- `packages/gateway/src/security/rate-limiter.ts`
- `packages/gateway/src/security/tool-deny.ts`
- `packages/gateway/src/security/outbound-queue.ts`
- `packages/gateway/src/config/env-preserve.ts`
- `packages/kernel/src/sandbox/manager.ts`
- `packages/kernel/src/sandbox/config.ts`
- `Dockerfile.sandbox`
- All corresponding test files in `tests/security/`

## Files to Modify

- `packages/gateway/src/dispatcher.ts` -- wrap inbound channel messages with external content markers
- `packages/gateway/src/auth.ts` -- add rate limiter, timing-safe comparison
- `packages/gateway/src/index.ts` -- outbound queue replay on startup, tool deny middleware
- `packages/kernel/src/spawn.ts` -- sandbox container option for sub-agents
- `home/system/config.json` -- security config section
