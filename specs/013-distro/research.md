# 013: Linux Distro -- Research Notes

## Decision Context

Matrix OS is currently a userspace application that runs on Node.js on top of macOS/Linux. The question: what would it take to make it a proper operating system you can install on hardware?

## Options Explored

### Option A: Docker Containers on VPS (Multi-Tenant)
Standard deployment for production. Each user gets an isolated container. Already spec'd in 008-cloud. Caddy reverse proxy with wildcard TLS routes `*.matrix-os.com` to per-user containers on a Docker network. Platform service handles signup, auth, container lifecycle.

**Verdict**: Right production approach. Needs Dockerfile (doesn't exist yet).

### Option B: Custom Linux Distro (Appliance Image)
Take minimal Linux, auto-boot into Matrix OS. User never sees Linux. Boot splash -> auto-login -> cage (Wayland kiosk compositor) -> Chromium fullscreen -> Matrix OS shell.

**Verdict**: Incredible demo value. "Flash this SD card, boot, you're in Matrix OS." Same codebase as Docker, different packaging.

### Option C: Desktop Environment Replacement
Replace GNOME/KDE on existing Linux install. Session entry for display manager.

**Verdict**: Too much work (10-14 weeks). Decades of desktop expectations to replicate. Not worth it.

### Option D: Bare Metal / Custom Kernel
Write a bootloader and minimal kernel that runs Node.js directly.

**Verdict**: Wildly impractical. Multi-year effort. V8 assumes POSIX.

## Chosen Approach: A + B (Docker + Distro Image)

Same build artifact powers both:
```
Source code
    |
    +-- next build (shell)
    +-- tsc (gateway + kernel)
    |
    +-> Docker image     -> VPS multi-tenant (production)
    +-> mkosi image      -> USB/UTM bootable (x86 demo)
    +-> rpi-image-gen    -> SD card bootable (Pi demo)
```

## Key Technology Decisions

### cage (Wayland Kiosk Compositor)
- Tiny (~2000 lines of C), runs one app fullscreen via Wayland
- Replaces entire GNOME/KDE stack (~800MB) with a 50KB binary
- Talks directly to GPU via KMS/DRM
- User can't tell they're looking at a browser
- Does NOT restrict the system -- full `apt install` still works underneath
- v0.2.1 (Oct 2025), actively maintained

### mkosi (x86 Images)
- systemd's official image builder
- Single `mkosi.conf` file defines the entire system
- Outputs: QCOW2 (UTM), ISO (USB boot), raw disk
- Supports Ubuntu, Debian, Fedora, Arch
- Test with `mkosi boot` before deploying
- Both x86-64 and ARM64

### rpi-image-gen (Raspberry Pi Images)
- Official Raspberry Pi tool, released March 2025
- YAML-based declarative config
- 2-4 minute builds (fast iteration)
- Outputs `.img` for SD card flashing
- Debian Bookworm based

### Plymouth (Boot Splash)
- Standard Linux boot splash system
- Custom theme with Matrix OS logo
- Loads before systemd, shows during boot
- `splash quiet` kernel parameters

### systemd Auto-Login + Services
Three services make it work:
1. `matrix-gateway.service` -- starts Hono backend
2. `matrix-shell.service` -- starts Next.js frontend
3. `matrix-kiosk.service` -- cage + Chromium fullscreen

No display manager, no X11, no desktop environment.

## Why Not a Custom Kernel?

The Claude Agent SDK needs HTTPS + WebSocket to talk to Anthropic's API. That requires a full TLS stack, TCP/IP stack, DNS resolver, etc. All of these come free with Linux. Rebuilding them is years of work for no user-visible benefit. Every "custom OS" product uses Linux underneath: ChromeOS (Gentoo), Steam Deck (Arch), Tesla (custom Linux).

## Architecture Comparison

### Current (Development)
```
Browser -> Next.js shell -> Gateway -> Kernel -> Claude API
  (all running on macOS via bun run dev)
```

### Docker (Production)
```
Caddy -> Container [Gateway + Shell + Kernel] -> Claude API
  (each user gets a container on VPS)
```

### Distro (Hardware/Demo)
```
cage -> Chromium -> [Gateway + Shell + Kernel] -> Claude API
  (boots from SD card or USB, no host OS visible)
```

## Full Linux Underneath

cage only controls the display. The system is still a full Debian/Ubuntu:
- `apt install` works normally
- bash/zsh available via built-in terminal or SSH
- All Linux packages available
- systemd manages services
- Standard filesystem hierarchy
- Switch to TTY2 with Ctrl+Alt+F2 for raw terminal

The user experiences Matrix OS as the entire interface, but can access full Linux through the built-in terminal component (xterm.js + node-pty).
