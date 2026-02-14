# 013: Linux Distro + Container Deployment -- Tasks

## Phase A: Docker (T500-T506)

### T500: Dockerfile (multi-stage build)
- [x] Stage 1: Node 22 Alpine builder with pnpm, native build tools
- [x] Stage 2: Production image with Node 22, git, production deps
- [x] Build shell (next build) and gateway (tsc) in builder stage
- [x] Handle node-pty and better-sqlite3 native compilation
- [x] .dockerignore for node_modules, .git, tests, specs, docs
- [ ] Verify image builds and gateway starts
- **Output**: Working `Dockerfile` at repo root
- **Blocked by**: nothing

### T501: docker-compose.yml (dev/test)
- [x] Gateway + shell service definitions
- [x] Volume mount for ~/matrixos/ persistence
- [x] Port mapping (3000, 4000)
- [x] Environment variables (ANTHROPIC_API_KEY, MATRIX_HOME)
- [x] Health check configuration
- [ ] `docker compose up` boots Matrix OS
- **Output**: Working `docker-compose.yml` at repo root
- **Blocked by**: T500

### T502: Multi-arch build (ARM64 + x86)
- [ ] Docker buildx setup for linux/amd64 + linux/arm64
- [ ] Test node-pty compilation on both architectures
- [ ] CI/CD build script (GitHub Actions)
- **Output**: Multi-arch Docker image
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

### T505: API key proxy + cost tracking
- [ ] Reverse proxy for Anthropic API calls
- [ ] Per-user token/cost tracking
- [ ] Quota enforcement (configurable per user)
- [ ] Dashboard endpoint for usage stats
- **Output**: Usage-tracked, quota-limited AI access
- **Blocked by**: T501

### T506: GitHub Actions CI
- [ ] Build Docker image on push to main
- [ ] Push to GitHub Container Registry (ghcr.io)
- [ ] Tag with commit SHA + latest
- [ ] Run tests inside container
- **Output**: Automated image builds
- **Blocked by**: T500

## Phase B: Distro Image (T510-T517)

### T510: systemd service files
- [ ] matrix-gateway.service (Hono backend, port 4000)
- [ ] matrix-shell.service (Next.js frontend, port 3000)
- [ ] matrix-kiosk.service (cage + Chromium fullscreen on TTY1)
- [ ] Auto-restart on failure (Restart=always)
- [ ] Proper ordering (After= dependencies)
- **Output**: Three .service files in `distro/systemd/`
- **Blocked by**: nothing

### T511: Plymouth boot splash theme
- [ ] Matrix OS logo (SVG -> PNG at multiple resolutions)
- [ ] Theme configuration (matrix-os.plymouth + matrix-os.script)
- [ ] Spinner animation
- [ ] Install script
- **Output**: Plymouth theme in `distro/plymouth/matrix-os/`
- **Blocked by**: nothing

### T512: mkosi configuration (x86-64)
- [ ] mkosi.conf with Ubuntu 24.04 base
- [ ] Package list (Node.js, cage, chromium, git, plymouth, openssh)
- [ ] Post-install script to copy gateway + shell + services
- [ ] Auto-login configuration (no display manager)
- [ ] Network configuration (systemd-networkd, DHCP)
- [ ] Test with `mkosi boot` in QEMU
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
