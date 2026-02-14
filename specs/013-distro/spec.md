# 013: Linux Distro + Container Deployment

## Problem

Matrix OS only runs as a dev server on the developer's machine. It can't be deployed to a VPS for users, and it can't boot on real hardware. There's no Dockerfile, no container config, no bootable image.

## Solution

Three deployment targets from a single codebase:

1. **Docker image** -- containerized gateway + shell for VPS multi-tenant deployment
2. **mkosi image** -- bootable x86-64 Linux image for USB drives and UTM VMs
3. **rpi-image-gen image** -- bootable ARM64 image for Raspberry Pi

## Architecture

### Docker (Production)

```
VPS (Hetzner)
  +-- Caddy (wildcard TLS, reverse proxy)
  |    +-- *.matrix-os.com -> per-user container ports
  |
  +-- Docker Network: matrixos-net
       +-- Container: user-1 (gateway:4001 + shell:3001)
       +-- Container: user-2 (gateway:4002 + shell:3002)
       +-- ...
       +-- Volumes: /data/users/{handle}/matrixos/
```

### Distro (Hardware/Demo)

```
Hardware (Pi / x86 / UTM)
  +-- Linux kernel + minimal rootfs
  +-- systemd
  |    +-- matrix-gateway.service  (Hono on :4000)
  |    +-- matrix-shell.service    (Next.js on :3000)
  |    +-- matrix-kiosk.service    (cage + Chromium fullscreen)
  +-- Plymouth boot splash
  +-- Auto-login (no display manager)
```

### Boot Flow (Distro)

```
Power on
  -> UEFI/BIOS
  -> Linux kernel + initramfs
  -> Plymouth splash (Matrix OS logo)
  -> systemd multi-user.target
  -> matrix-gateway.service starts (port 4000)
  -> matrix-shell.service starts (port 3000)
  -> matrix-kiosk.service starts
  -> cage launches Chromium --kiosk http://localhost:3000
  -> User sees Matrix OS fullscreen
```

Total boot time: ~15s on Pi 5, ~8s on x86 SSD.

## Docker Image

### Multi-Stage Build

Stage 1 (builder): Node 22 Alpine, pnpm install, next build, tsc
Stage 2 (production): Node 22 Alpine, production deps only, git

### Key Concerns

- **node-pty**: native C++ addon, needs python3 + make + g++ + linux-headers in build stage
- **better-sqlite3**: native addon, same build toolchain
- **Image size**: ~400-500MB due to native build toolchain
- **ARM64 + x86**: use Docker buildx for multi-arch

### Ports

- 3000: Next.js shell (HTTP)
- 4000: Hono gateway (HTTP + WebSocket)

### Volumes

- `/home/user/matrixos/` -- persistent home directory (all state)

### Environment

- `ANTHROPIC_API_KEY` -- required
- `MATRIX_HOME` -- home directory path (default: /home/user/matrixos)
- `PORT` -- gateway port (default: 4000)

## Distro Image

### Display Stack

```
Linux DRM/KMS -> cage (Wayland) -> Chromium (kiosk) -> localhost:3000
```

No X11, no display manager, no desktop environment. cage is a ~50KB Wayland compositor that runs one app fullscreen.

### Base OS

- **x86**: Ubuntu 24.04 via mkosi (apt package ecosystem)
- **Pi**: Debian Bookworm via rpi-image-gen

### Included Packages

Core: systemd, networkd, resolved, bash, git, openssh-server
Runtime: nodejs (22+), pnpm
Display: cage, chromium
Boot: plymouth
App: matrix-os gateway + pre-built shell

### First Boot

1. `ensureHome()` creates ~/matrixos/ from template
2. Gateway starts, shell starts
3. Chromium opens to localhost:3000
4. User sees onboarding flow (012-onboarding)

### System Access

- Built-in terminal (xterm.js + node-pty) for command-line access
- SSH server for remote access
- Ctrl+Alt+F2 for raw TTY (debug)
- Full `apt install` works -- it's a real Linux underneath

## docker-compose (Development)

For local testing of the containerized setup:
- gateway service (builds from Dockerfile)
- Volume mount for home directory
- Port mapping 3000 + 4000

## Plymouth Theme

Custom boot splash:
- Matrix OS logo centered
- Progress spinner
- `splash quiet` kernel parameters
- Theme at `/usr/share/plymouth/themes/matrix-os/`

## Dependencies

- Dockerfile unblocks everything else
- docker-compose unblocks local container testing
- mkosi config requires working Dockerfile (uses same built artifacts)
- rpi-image-gen config is independent (ARM64 native build)
- Plymouth theme is independent
- 008-cloud platform service builds on top of Docker image
