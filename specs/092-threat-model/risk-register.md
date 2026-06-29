# Matrix OS — Risk Register

Scored, sortable companion to [`threat-model.md`](./threat-model.md). Each row is
issue-ready. Scoring per [§7](./threat-model.md#7-how-risk-is-scored):
**Risk = Likelihood × Blast radius**, `9 CRIT · 6 HIGH · 3–4 MED · 1–2 LOW`.

- **Likelihood:** `3` exposed (no foothold) · `2` foothold (installed app / channel / popped box) · `1` chained (needs another bug or a privileged secret).
- **Blast:** `3` all users (platform / shared R2) · `2` one user (a VPS) · `1` one app.
- **Status:** re-verified against `main` @ `205a8bb0b`. `PERSISTENT` / `CHANGED` / `FIXED` / `MOVED` / `NEW`.

| ID | L | B | Risk | Status | Finding | Where |
|----|---|---|------|--------|---------|-------|
| **F3** | 2 | 2 | **HIGH (4→pri)** | PERSISTENT | App forges `body.app`, reads every other app's data | `server.ts:3162`, `AppViewer.tsx:48-73,181` |
| **F4** | 2 | 3 | **HIGH (6)** | PERSISTENT | Same full-bucket R2 key on every VPS → cross-tenant backups | `customer-vps-config.ts:51-52` |
| **F5** | 3 | 2 | **HIGH (6)** | PERSISTENT | Kernel runs all sources under `bypassPermissions`, scan is detect-only | `options.ts:131`, `external-content.ts` |
| **F7** | 2 | 2 | **HIGH (4)** | PERSISTENT | `credentials.json` `0644` + `.env*` not sync-ignored → R2 exfil | `postgres-manager.ts:69`, `syncignore.ts:5-21` |
| **F6** | 1 | 2 | MED (3, amp) | PERSISTENT | `Bash` bypasses file-protection hook; `tool-deny.ts` dead; approval-hook unwired | `evolution.ts:22`, `hooks.ts`, `tool-deny.ts` |
| **F8** | 2 | 2 | MED (4, amp) | PERSISTENT | Store apps: no review, scan, or permission model | `app-publish.ts:24-52`, `app-fork.ts` |
| **F1** | 1 | 3 | **MED (3)** | CHANGED ↓ | Platform social trusts `body.authorId`/`x-user-id` (now bearer-gated) | `social-api.ts:75-115`, mount `main.ts:3744` |
| **F2** | 1 | 3 | **MED (3)** | CHANGED ↓ | Platform store trusts `body.authorId` (now bearer-gated) | `store-api.ts:65-100`, mount `main.ts:3738` |
| **N1** | 1 | 3 | **MED (3)** | NEW | Platform public/private split is mount-order-dependent on `main.ts:3374` | `main.ts:3374-3386` |
| **F9** | 1 | 3 | MED (3) | PERSISTENT | Gateway trusts `x-platform-user-id`; validates existence, not caller | `request-principal.ts:126`, `server.ts:1128` |
| **F10** | 1 | 3 | MED (3) | PERSISTENT | Host bundles SHA256-only (no signature), installs anyway if hash missing | `matrix-sync-agent:178-189` |
| **F12** | 1 | 2 | MED (2, amp) | PERSISTENT | IPC/MCP server: no per-caller auth on `manage_cron`/`call_service` | `ipc-server.ts:64+` |
| **F14** | 2 | 1 | MED (2, $) | PERSISTENT | No per-source spend cap on `generate_image`/`speak` (financial, not DoS) | `ipc-server.ts:648-787` |
| **F15** | 1 | 2 | MED (2) | PERSISTENT | Secrets shipped in cloud-init user-data (provider may log) | `customer-vps-cloud-init.ts:29-35` |
| **F17** | 1 | 2 | MED (2, amp) | PERSISTENT | PTY inherits full `process.env` → secrets in shell (chains with F5) | `pty.ts:55` vs `zellij-runtime.ts` |
| **N2** | 1 | 2 | LOW (2) | NEW | `public-origin.ts` trusts `x-forwarded-host`/`proto` when no canonical set | `public-origin.ts:26-31` |
| **F13** | 1 | 1 | LOW (1) | PERSISTENT* | WS token in URL query string (browser-forced; mitigated) | `auth.ts:223-231` |
| **F18** | 1 | 1 | LOW (1) | PERSISTENT | Preview-manager validates resolved IP but doesn't pin it (DNS-rebind window) | `preview-manager.ts:151-183` |
| **F16** | 1 | 2 | LOW (1) | PERSISTENT | `curl | bash` NodeSource/Homebrew install, no checksum | `setup-server.sh:9`, `matrix-install-linux-tools:98-105` |
| **F11** | 1 | 2 | LOW (1) | CHANGED ↓ | `/vps/register` token now validated in service layer (was implicit) | `customer-vps.ts:599-601` |

\* F13 is intentional (browsers can't set WS auth headers) and mitigated by
timing-safe compare + rate limiting; tracked for log-hygiene, not treated as live.

## Notes on re-verification deltas

- **F3 — NOT fixed.** One exploration pass (and the original spec's second
  explorer) called this fixed because the relay pins the *envelope* `app` to the
  iframe slug. Traced by hand: the envelope check (`AppViewer.tsx:181`) guards the
  wrong field. The data-access decision is made from `body.app` inside `init.body`,
  which `handleBridgeFetch` forwards verbatim (`:61`) and the gateway reads
  unchecked (`server.ts:3162`). The new `app-viewer-bridge-policy.ts` is a URL
  allowlist only. **F3 stays the top live finding.**
- **F1/F2 — downgraded, not closed.** The `main.ts` refactor added a global bearer
  middleware (`:3374`) ahead of the social/store mounts, closing the
  internet-facing impersonation. Residual: handlers still trust the body, and the
  gate is positional → **N1**. Score drops from 9 (CRIT) to 3 (MED).
- **F11 — downgraded.** Registration token is now checked with a timing-safe hash
  compare inside `service.register` (`customer-vps.ts:599-601`). Still belongs at
  the route boundary, but no longer "implicit/unguarded."
- **F4 — confirmed cross-tenant.** Presign scoping protects the *normal* path
  (`internal-sync-routes.ts` `keyAllowedForUser`), but the standing credential is
  still global and full-bucket. Unchanged.

## Fix sequencing

Sorted by score, deduped by shared fix:

1. **F3** (relay overwrites `body.app` + gateway ownership check) — closes the
   sandbox data-theft path; de-fangs F8.
2. **F4** (per-user R2 creds or presign-only) — closes the cross-tenant escape; F7
   stops being an R2-exfil amplifier once this lands.
3. **F5 + F6 + F12 + F17** (per-source tool gating, wire approval hook, blocking
   injection scan, `Bash` arm on file hook, env allowlist on PTY) — one kernel
   hardening effort; overlaps `025-security`.
4. **F1 + F2 + N1** (session-derived principal, drop body identity, mount-order
   test) — one platform change.
5. **F7** (`0600` + sync ignore patterns) — two one-liners, do anytime.
6. Tail: **F10** (sign bundles), **F15** (post-boot secret fetch), **N2** (set
   canonical origin in prod), **F16/F18** (pin + checksum).

---

*AI-assisted. Not a professional audit — get a real pentest before production reliance.*
