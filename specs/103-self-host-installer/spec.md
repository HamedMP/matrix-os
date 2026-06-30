# Feature Specification: Self-Host Server Installer

**Feature Branch**: `103-self-host-installer`  
**Created**: 2026-06-30  
**Status**: Draft  
**Input**: User description: "sync with main, spec this out, and let's do it. We need proper docs on the docs page, update GitHub README as an option, add it to landing as one option, and host the script on the main domain."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install Matrix on an Existing VPS (Priority: P1)

A developer with a fresh Linux VPS can run one command from `matrix-os.com`, answer no mandatory interactive prompts, and get a browser-accessible Matrix OS shell with gateway, terminal services, code-server, local Postgres, and optional coding tools starting under systemd.

**Why this priority**: This is the core public promise for developers who want cloud coding without signing up for managed Matrix Cloud first.

**Independent Test**: Run the installer against a supported apt-based Linux host or a fixture that validates the generated files, then confirm the documented URL, credentials, and services are produced.

**Acceptance Scenarios**:

1. **Given** a fresh supported VPS, **When** the user runs `curl -fsSL https://matrix-os.com/install-server.sh | sudo bash`, **Then** Matrix OS installs from a verified host bundle and starts the shell, gateway, code-server proxy, local Postgres, and nginx.
2. **Given** the installer finishes, **When** the user opens the printed URL, **Then** the UI is protected by generated credentials and same-origin Matrix API calls reach the local gateway.
3. **Given** code-server is not installed yet, **When** Matrix code services start, **Then** the existing tool-pack installer installs code-server asynchronously and the `/code/` path is available after startup.

---

### User Story 2 - Understand Self-Host Tradeoffs (Priority: P2)

A developer comparing hosted Matrix Cloud and self-host Matrix can see exactly what they gain and miss before running the script.

**Why this priority**: The public pitch must avoid overpromising managed-cloud parity while making the self-host option easy to choose.

**Independent Test**: Review the docs, landing page, and README and confirm each surface names self-host as an option, shows the main-domain install command, and distinguishes managed features from self-host responsibilities.

**Acceptance Scenarios**:

1. **Given** a visitor on the landing page, **When** they review deployment options, **Then** self-host appears alongside hosted Matrix with a main-domain install command or docs link.
2. **Given** a GitHub visitor, **When** they read the README quick start, **Then** they can choose hosted, self-hosted VPS, CLI, or source development without confusing the paths.
3. **Given** a docs reader, **When** they open self-host docs, **Then** they see prerequisites, command, configuration, what is included, what is not included, and verification commands.

---

### User Story 3 - Keep the Installer Maintainable (Priority: P3)

Maintainers can update the source installer and trust that the public website-hosted copy stays identical.

**Why this priority**: The website must host the script on the main domain, but duplicated installer scripts are risky without drift prevention.

**Independent Test**: Run a focused test that compares `scripts/install-server.sh` with `www/public/install-server.sh` and checks the installer contract for auth, checksum verification, systemd services, and main-domain docs.

**Acceptance Scenarios**:

1. **Given** the source installer changes, **When** tests run, **Then** they fail unless the `www/public` copy is updated.
2. **Given** a future edit weakens auth or checksum behavior, **When** focused tests run, **Then** they catch the missing required behavior.

### Edge Cases

- Unsupported Linux distributions must fail before partial installation rather than attempting unknown package-manager commands.
- Missing systemd must fail before writing service files.
- Host bundle download or checksum mismatch must abort before extraction.
- Existing Matrix installs must reuse the `matrix` user and Matrix directories without deleting owner data under `/home/matrix/home`.
- Direct shell exposure on port 3000 must remain loopback-only; public access goes through nginx.
- Browser requests carrying reserved Matrix platform/native session headers must be rejected in self-host mode.
- Self-host docs must not imply managed routing, managed backups, Pipedream, Clerk session routing, mobile/desktop handoff, or fleet upgrades are available by default.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a main-domain installer URL at `https://matrix-os.com/install-server.sh`.
- **FR-002**: The installer MUST run as root and fail fast when root, Linux, or systemd prerequisites are missing.
- **FR-003**: The installer MUST install only from a published host bundle and MUST verify the downloaded bundle against its `.sha256` before extraction.
- **FR-004**: The installer MUST create or reuse a dedicated `matrix` system user and preserve owner-controlled data under the Matrix home directory.
- **FR-005**: The installer MUST generate fresh local secrets for gateway bearer auth, code-server proxy auth, Postgres, and initial browser access.
- **FR-006**: The installed shell MUST support an explicit self-host mode that bypasses Clerk while preserving gateway bearer injection for same-origin API, file, app, and WebSocket paths.
- **FR-007**: The public browser surface MUST be protected by a local reverse proxy authentication layer by default.
- **FR-008**: The installer MUST start Matrix services using systemd and provide verification commands to inspect status and logs.
- **FR-009**: The docs MUST describe what self-host users gain and what they miss compared with managed Matrix Cloud.
- **FR-010**: The README and landing page MUST present self-host install as a first-class option without replacing the hosted cloud path.
- **FR-011**: The implementation MUST include tests that prevent drift between the source installer and website-hosted installer copy.

### Security Architecture

| Surface | Default auth | Notes |
|---------|--------------|-------|
| Public shell UI | nginx Basic Auth with generated password | Preview default for easy VPS installs; docs recommend HTTPS, Tailscale, Cloudflare Access, or equivalent for long-term use. |
| Gateway API/files/apps/WebSocket | Internal `MATRIX_AUTH_TOKEN` injected by shell proxy | Public requests should reach these paths through the shell/nginx route, not directly to port 4000. |
| code-server | Internal `MATRIX_CODE_PROXY_TOKEN` injected by nginx `/code/` route | code-server itself stays loopback and auth-free behind the Matrix proxy token. |
| Local Postgres | Loopback only with generated password | App data remains owner-local on the VPS. |
| Managed platform features | Not configured by default | Clerk/Pipedream/platform routing remain managed-cloud concerns unless a later BYO control-plane feature exists. |

### Key Entities *(include if feature involves data)*

- **Standalone Install Profile**: The generated local configuration that declares self-host mode, handle, local URLs, and generated secrets.
- **Host Bundle**: The immutable runtime artifact containing Matrix app, shell, gateway, launchers, and systemd unit templates.
- **Public Installer Copy**: The static website copy served from `matrix-os.com` and validated against the source installer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A supported VPS can reach a Matrix OS browser shell with one public command and no source build.
- **SC-002**: The installer aborts before extraction on checksum mismatch.
- **SC-003**: The shell runs in self-host mode without requiring Clerk, while gateway proxy requests still carry the internal bearer token.
- **SC-004**: Public docs, README, and landing page all show self-host install as an option and use the main-domain script URL.
- **SC-005**: Focused tests fail if the website-hosted installer copy diverges from the source installer.
