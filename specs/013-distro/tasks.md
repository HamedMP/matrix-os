# 013: Linux Distro + Container Deployment -- Tasks

## Phase A: Docker (T500-T506)

### T500: Dockerfile (multi-stage build) -- DONE
- [x] Stage 1: Node 22 Alpine builder with pnpm, native build tools
- [x] Stage 2: Production image with Node 22, git, production deps
- [x] Build shell (next build) and gateway (tsc) in builder stage
- [x] Handle node-pty and better-sqlite3 native compilation
- [x] .dockerignore for node_modules, .git, tests, specs, docs
- [x] Verify image builds and gateway starts
- [x] Non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
- [x] Claude Code CLI installed globally (Agent SDK spawns claude subprocess)
- [x] Dynamic WebSocket URL (derive from window.location for OrbStack/VPS)
- **Output**: Working `Dockerfile` at repo root
- **Blocked by**: nothing

### T501: docker-compose.yml (dev/test) -- DONE
- [x] Gateway + shell service definitions
- [x] Volume mount for ~/matrixos/ persistence
- [x] Port mapping (3000, 4000)
- [x] Environment variables via .env.docker
- [x] Health check configuration
- [x] `docker compose up` boots Matrix OS
- [x] First-boot home directory initialization from template
- **Output**: Working `docker-compose.yml` at repo root
- **Blocked by**: T500

### T502: Multi-arch build (ARM64 + x86) -- DONE
- [x] Docker buildx setup for linux/amd64 + linux/arm64
- [x] CI/CD build script (GitHub Actions with QEMU + buildx)
- [x] Push to ghcr.io/hamedmp/matrix-os (SHA + latest tags)
- [x] GHA layer caching (cache-from/cache-to type=gha)
- **Output**: `.github/workflows/docker.yml`
- **Blocked by**: T500

### T503: Container networking (inter-OS messaging)
- [ ] Docker network (matrixos-net) configuration
- [ ] Gateway accepts `from` field on /api/message (external sender)
- [ ] Sandboxed context for external requests (call center model)
- [ ] DNS resolution between containers (alice -> bob via container name)
- **Output**: Two containers can message each other's kernels
- **Blocked by**: T501

### T504: Idle/wake lifecycle
- [ ] Health check endpoint reports last activity timestamp
- [ ] Orchestrator stops container after 30min idle
- [ ] Caddy on-demand start on incoming HTTP request
- [ ] Container resumes from stopped state (volume preserved)
- **Output**: Containers auto-sleep and auto-wake
- **Blocked by**: T501

### T505: API key proxy + cost tracking -- DONE
- [x] Hono reverse proxy at `packages/proxy/` (forwards /v1/* to Anthropic API)
- [x] Hybrid key model: shared default key, containers can bring their own via x-api-key
- [x] User identification via x-matrix-user header
- [x] SQLite usage tracking (api_usage table with token counts + cost)
- [x] Anthropic pricing calculator (Opus, Sonnet, Haiku per-token rates)
- [x] Quota enforcement (daily + monthly limits per user)
- [x] Streaming SSE passthrough with async usage collection
- [x] Usage endpoints: GET /usage/:userId, GET /usage/summary, POST /quotas/:userId
- [x] Multi-tenant docker-compose with ANTHROPIC_BASE_URL routing
- **Output**: `packages/proxy/`, `distro/docker-compose.multi.yml`
- **Blocked by**: T501

### T506: GitHub Actions CI -- DONE (merged into T502)
- [x] Build Docker image on push to main
- [x] Push to GitHub Container Registry (ghcr.io)
- [x] Tag with commit SHA + latest
- **Output**: Combined with T502 in `.github/workflows/docker.yml`
- **Blocked by**: T500

## Phase B: Distro Image (T510-T517)

### T510: systemd service files -- DONE
- [x] matrix-gateway.service (Hono backend, port 4000)
- [x] matrix-shell.service (Next.js frontend, port 3000)
- [x] matrix-kiosk.service (cage + Chromium fullscreen on TTY1)
- [x] Auto-restart on failure (Restart=always)
- [x] Proper ordering (After= dependencies)
- [x] EnvironmentFile for /etc/matrix-os/env
- **Output**: Three .service files in `distro/systemd/`
- **Blocked by**: nothing

### T511: Plymouth boot splash theme -- DONE
- [x] Matrix OS logo PNG
- [x] Theme configuration (matrix-os.plymouth + matrix-os.script)
- [x] Spinner animation
- **Output**: Plymouth theme in `distro/plymouth/matrix-os/`
- **Blocked by**: nothing

### T512: mkosi configuration (x86-64) -- DONE
- [x] mkosi.conf with Ubuntu 24.04 base
- [x] Package list (Node.js, cage, chromium, git, plymouth, openssh)
- [x] Post-install script to copy gateway + shell + services
- [x] Auto-login configuration (no display manager)
- [x] Network configuration (systemd-networkd, DHCP)
- [x] ExtraTrees directive for mkosi.extra/ overlay
- [x] mkosi.build script for preparing application artifacts
- [x] /etc/matrix-os/env default environment file
- [x] First-boot systemd oneshot (matrix-firstboot.service)
- [x] Fixed shell service ExecStart (node_modules/next/dist/bin/next)
- **Output**: Bootable x86 image via `mkosi build`
- **Blocked by**: T510, T511

### T513: rpi-image-gen configuration (ARM64 Pi)
- [ ] YAML config for Debian Bookworm base
- [ ] Profile layer with Node.js + cage + chromium
- [ ] Matrix OS application layer (gateway + shell)
- [ ] Kiosk service integration
- [ ] WiFi configuration support
- [ ] Test on Raspberry Pi 5
- **Output**: Flashable `.img` for Raspberry Pi
- **Blocked by**: T510, T511

### T514: First-boot setup (distro-specific)
- [ ] Detect first boot (no ~/matrixos/ exists)
- [ ] Run ensureHome() to create home directory
- [ ] WiFi setup screen (if no network connection)
- [ ] API key input screen (or pre-configured)
- [ ] Trigger onboarding flow (012-onboarding)
- **Output**: Clean first-boot experience on hardware
- **Blocked by**: T512 or T513

### T515: UTM testing on Mac
- [ ] Document UTM VM setup with mkosi image
- [ ] Test boot flow (Plymouth -> cage -> shell)
- [ ] Test networking (bridge mode for LAN access)
- [ ] Test persistence (reboot preserves state)
- **Output**: Verified UTM workflow for Mac development
- **Blocked by**: T512

### T516: USB live boot (x86)
- [ ] mkosi ISO output format
- [ ] Persistent overlay (changes survive reboot)
- [ ] Boot from USB on any x86 laptop
- [ ] Document flashing with dd / balenaEtcher
- **Output**: Bootable USB stick with Matrix OS
- **Blocked by**: T512

### T517: OTA updates
- [ ] Update mechanism (git pull + rebuild, or image swap)
- [ ] A/B partition scheme for safe updates
- [ ] Rollback on failed update
- [ ] Version display in shell
- **Output**: Distro can update itself
- **Blocked by**: T512

## Task Dependency Graph

```
T500 (Dockerfile)
  +-> T501 (compose) -> T503 (networking)
  |                  -> T504 (idle/wake)
  |                  -> T505 (API proxy)
  +-> T502 (multi-arch)
  +-> T506 (CI)

T510 (systemd) --+-> T512 (mkosi) -> T515 (UTM)
T511 (plymouth) -+                 -> T516 (USB)
                  +-> T513 (rpi)   -> T514 (first boot)

T512 -> T517 (OTA)
```
