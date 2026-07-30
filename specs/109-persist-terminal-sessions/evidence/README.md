# Terminal Runtime Evidence

Production implementation is authorized by the reviewed, exact-head spike proof
below. It authorizes only the architecture and candidate bytes recorded here;
each production layer still requires its own tests and review gates.

## Immutable S1/S2 proof

- Pull request: [#1092](https://github.com/HamedMP/matrix-os/pull/1092)
- Exact head: `f5a91fb6cd01eb30a747f04766a7ef67371acb3c`
- Workflow: [Terminal Runtime Spikes run 29958582126](https://github.com/HamedMP/matrix-os/actions/runs/29958582126)
- Artifact: `terminal-runtime-spikes-pr-1092-f5a91fb` (artifact ID `8545094419`)
- Validated `summary.json` SHA-256: `a862a75bda316a54754205300950463c18243b58aea727e45b6d5610e35b1213`
- GitHub artifact archive SHA-256: `78da12a718ce662ac9d17695efa47bc1284ef19e83eddf7a64f29cec45ffd679`
- Host: Ubuntu `24.04`, systemd `255 (255.4-1ubuntu8.12)`, kernel `6.8.0-90-generic`
- Privacy scan: pass, zero findings, 5,253 total evidence bytes

## Proven candidate

- Build ID: `v0.44.3-matrix.1`
- Source version: Zellij `0.44.3`
- Source SHA-256: `33ae61fc802b59462fed49b424893596d3aa819646bdce53d5602f714c1264fe`
- Patch SHA-256: `bee3d6c227402258faee58c9f57ed282a368ab39fd38e619b39d4bd5ec8f2571`
- Binary SHA-256: `534455dc62c8e3753918d012547d10159ee07929f570a5873a754957502a49c4`
- Toolchain/target: Rust `1.92.0`, `x86_64-unknown-linux-musl`
- Fixed build root: `/tmp/matrix-zellij-build-v0.44.3-matrix.1`

Gate S1 passed all 13 checks. Gate S2 passed all 12 checks, including exact
option syntax, runtime cache mapping, layout and viewport restoration, bounded
scrollback, bounded loss window, native command confirmation, absence of
`--force-run-commands`, corruption fallback, complete deletion, bounded disk
accounting, and safe live serialization disablement.

Raw terminal contents, credentials, host IPs, user paths, and display names are
not committed or uploaded.
