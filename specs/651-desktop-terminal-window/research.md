# herdr-core qualification spike

Date: 2026-11-10. Binary: `hc` 0.1.19 (herdr-core at `a9298a26`). Host: macOS arm64 (Darwin 25.6).
Throwaway scripts were run outside the repository and are not committed. Only macOS arm64 was tested.

## Results against the spec's criteria

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| Q1 | Reproducible pinned artifact, Apache-2.0, no outside runtime dependency | **Not tested** | Docs say Linux builds are static and macOS ships a signed `Herdr Core.app`. No clean-machine install was done. |
| Q2 | Signs and notarizes inside the app | **Not tested** | Needs the release pipeline. Upstream's macOS bundle is signed by Herdr's own team ID; re-signing or shipping theirs is an owner decision. |
| Q3 | Explicit socket location, owner-only, no network listener | **Pass (macOS arm64)** | With `XDG_RUNTIME_DIR` set, the socket is `<dir>/herdr-core/<session>.sock`. Directories are 0700; the socket file itself is 0755, so the directory is the boundary. `lsof -i` showed no TCP/UDP sockets. A second-OS-user connect attempt was not run. |
| Q4 | No auto-update or outbound network | **Partly** | Docs describe only the explicit `hc update`. `lsof -i` was empty at start and after two minutes. No packet capture. |
| Q5 | Survives app quit and crashes; relists terminals | **Pass (macOS arm64)** | `kill -9` of the core left terminals live and the next connection adopted the holder. The app-level test restarts Electron and reattaches the same terminal. Not run 20 times. |
| Q6 | Version handshake before any other call | **Pass** | `hello` returns `version`, `generation`, `features`. The client refuses any other version or generation and sends nothing else. |
| Q7 | Latency and throughput | **Partly** | Echo round trip 2.9 ms on loopback in framed mode. No throughput test. |
| Q8 | Holder crash detected; terminals' fate recorded | **Pass (behaviour recorded)** | `kill -9` of the holder ended every terminal it held. A `keep=true` terminal came back as a fresh shell. |
| Q9 | No sharing with a user-installed herdr | **Pass (macOS arm64)** | With private `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` and its own session, the app's core listed no user machines and the user's default session listed none of the app's terminals. |

## Findings that changed the design

- **`terminal.run` environment is additive.** A terminal inherits the core's environment plus `HC_*`; `env` cannot unset anything. The isolation variables would therefore leak into every shell, pointing the user's tools at the app's config directory. The app starts each shell through `/usr/bin/env -u …` to remove them. A shell that herdr starts on its own for `keep` recovery would not get that treatment, so the app does **not** use `keep`: a terminal whose holder dies is reported as ended, not silently replaced.
- **Socket paths are short.** herdr-core refuses a session whose socket path exceeds the OS limit (103 bytes on macOS). `userData` is too long on macOS, so sockets live in `~/.matrixos/dt/<8 hex of the profile>/`, and state and config stay under `userData/herdr/`.
- **Starting the core** is `hc server start`, which detaches. The holder is `hc hold --socket …` from the same binary path, so the binary must stay at a stable path while terminals run.
- **Status is already parsed.** herdr-core stores OSC 7501 reports and returns them in `terminal.list`. Local status needs no parser in the app. Only the fixed `state` vocabulary crosses IPC; the program's free text does not.

## Not done

- Linux and macOS x64.
- Signing and notarization of the app with the bundled binary. Fetch, checksum verification and packing are implemented (`scripts/release/fetch-herdr-core.mjs`) and were checked with an unsigned local macOS arm64 package; the release workflow, which is the only place the app is signed, has not run with it yet.
- A second-OS-user socket test, packet capture, throughput, and the 20-cycle crash loop.
- Emitting a real OSC 7501 report and seeing it in the UI.
