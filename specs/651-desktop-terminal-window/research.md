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

---

# Herdr sessions over SSH spike

Date: 2026-11-10. Host: one Linux x64 machine (Ubuntu 24.04, OpenSSH 9.6) acting as both ends.
Throwaway scripts ran outside the repository and are not committed.

**Question.** Can the Terminal window list, create, attach to and end terminals in the herdr-core
that the Herdr app uses on a remote machine, so that both apps show the same terminals?

**Answer.** Yes. No blocker was found. Two transports work; the spec picks the first.

## Setup

- "Remote" end: herdr-core on this machine, reached only through a throwaway `sshd` on
  `127.0.0.1:22651` with its own host key, one spike-only client key and `PasswordAuthentication no`.
  Cores tested: **0.1.20** (installed here) and **0.1.14** (the version the Matrix computers
  reported), each in its own session (`HC_SESSION`), so the live default session was never written to.
- Client end: the desktop's own `hc-client.ts` (written against the 0.1.19 protocol), and
  separately the pinned **0.1.19** binary from `desktop/herdr-core.json` (archive checksum matched).
- Second client, standing in for the Herdr app: plain `hc ls`, `hc run`, `hc send`, `hc read` and
  `hc kill` on the remote end, in the same session.
- `ssh` ran with `-F /dev/null`, `IdentitiesOnly=yes`, `IdentityAgent=none`, `BatchMode=yes`,
  `StrictHostKeyChecking=yes` and a known-hosts file holding only the expected host key.

## Transport A: the app speaks herdr's API through `ssh … hc connect` (chosen)

The main process starts `ssh` with the remote line and treats the child's stdin/stdout as the
socket. The existing client needed no protocol change; only its exact-version rule had to be
loosened for the test.

| Step | 0.1.20 core | 0.1.14 core |
| --- | --- | --- |
| Handshake (`hello`, framed mode), including SSH connect | pass, 176 ms | pass, 197 ms |
| `terminal.list` | pass | pass |
| `terminal.run` from the app; plain `hc ls` on the machine lists it | pass | pass |
| `terminal.attach`, type, read output (echo round trip) | pass, 20 ms | pass, 20 ms |
| Resize from the app (`stty size` in the terminal) | pass | pass |
| Second client types (`hc send`); the app's stream shows it | pass | pass |
| Second client reads the screen the app produced (`hc read`) | pass | pass |
| 60 MB of output with credit flow control | 167 MB/s | 181 MB/s |
| Terminal created on the machine appears in the app's list | pass | pass |
| App ends a machine-created terminal; machine ends an app-created one and the app's stream closes | pass | pass |

Further observations (0.1.20 core):

- **Same namespace.** `hc connect` with no session reaches the user's default session. A read-only
  `terminal.list` through it returned exactly the 12 terminals plain `hc ls` printed. Sharing
  therefore needs only the same OS user and the same session on the machine.
- **`hc connect` starts the core** when none is running for that session.
- **Shell.** `terminal.run` with neither `argv` nor `line` starts that machine's own shell in its
  home directory (hello feature `shell`, present in 0.1.14). The app does not need to know the
  remote shell, and none of the local `env -u …` treatment applies: the remote core is the user's own.
- **Two viewers.** Two connections attached to one terminal both receive output and both can type.
  The terminal takes the size of the viewer that attached or resized last (`observe: true` exists
  for watch-only viewers).
- **Line drop.** Killing `ssh` closed the stream and fired the disconnect within 11 ms. The
  terminal kept running; a new connection reattached and the history replay held the earlier output.
- **Version skew.** `hello` returns `version`, `generation: 1`, `methods` and `features`. Features
  grew between 0.1.14 (`framed, attach, events, status, shell`) and 0.1.20 (adds
  `resize_notifications, automatic_input, restart_environment`); everything this feature calls is in
  both. The current exact-version check reports a 0.1.20 core as `version-mismatch`, as designed
  for the private local core.

Failure cases, as the existing client sees them:

| Case | What happens |
| --- | --- |
| Host key differs from the pinned one, or no key is pinned | `ssh` exits 255 with "Host key verification failed." before any byte of the API is exchanged (about 50 ms) |
| herdr-core missing on the machine | the probe line exits 127 with "herdr-core is not installed here" |
| Text printed before the handshake (a chatty shell startup file) | the first line is not JSON; the client fails. It must be reported as a protocol error, not a crash |
| Unknown terminal / unknown machine | stable error kinds `not_found`, `machine_unknown` |

Things to carry into the design:

- A non-interactive SSH command gets the system `PATH`. `hc` installed in `~/.local/bin` is not on
  it. herdr's own remote line handles this, and the app should send the same shape:
  `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; [ -x "$p" ] || { …; exit 127; }; exec "$p" connect'`
  (with `HC_SESSION=<name>` before `exec` for a non-default session).
- The client must tell apart three ends of the SSH process: exit 255 (transport or host key),
  exit 127 (no herdr-core), and a clean handshake.

## Transport B: the bundled core adds the machine (works, not chosen)

The pinned 0.1.19 binary, with private state and runtime directories, ran
`hc machine add --via <ssh command> --name box`. It listed `box/t1`, created terminals with
`run --on box`, and ended a terminal created on the machine; the machine's own `hc` saw and ended
the ones created through the bundled core. So `machine/tN` addressing works across 0.1.19 → 0.1.20.

It is not chosen because the core then owns the connection: it writes the SSH command to
`machines.json`, keeps the line open and redials on its own. The address and host key would be
whatever was stored at add time, not fetched for each attempt, and the app's private holder would
become a network client the main process does not supervise.

## `ssh2` check (open question 9)

`ssh2` 1.17.0 installed without building its optional native add-ons and ran as pure JavaScript.
With the private key passed in memory and a `hostVerifier` comparing the SHA-256 fingerprint of
the presented host key:

- matching fingerprint: connected, ran the remote line on an exec channel and received herdr's
  `hello` reply (0.1.20, generation 1) in 328 ms;
- wrong fingerprint: refused during the handshake ("Host denied (verification failed)"), before
  authentication.

The full list/attach/kill sequence was not repeated through `ssh2`; an exec channel is a plain
byte stream, the same as the `ssh` child's stdin/stdout used above.

## After the spike: the committed host against real cores

`tests/desktop/herdr-session-host.test.ts` has an opt-in lane that runs the committed
`HerdrSessionHost` over the stdin/stdout of a real `herdr-core connect` (no SSH), with plain `hc`
as the second client. It passed on Linux x64 against 0.1.14, 0.1.19 and 0.1.20. The older opt-in
lane for local terminals passed against the pinned 0.1.19 on Linux x64 after the shared-module
refactor; that lane had only ever run on macOS arm64.

## Not tested

- macOS, and a real Matrix computer. Which OS user the requester's Herdr app logs in as on their
  Matrix computer, and that herdr-core is at `~/.local/bin` there, are unverified.
- `ssh2` beyond one check (below). The tables above used the system OpenSSH client.
- The device key encrypted at rest and decrypted in the main process; the spikes read a plain key file.
- `events.subscribe` (live updates instead of polling), `terminal.attach` with `observe` or `resumed`.
- More than two viewers, long-lived connections (keepalive, sleep/wake), and high-latency links.
- herdr-core older than 0.1.14, and a remote core of a different protocol generation.
