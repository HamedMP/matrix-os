# Proposed OpenCode exclusive custom-tool discovery adapter

Status: **proposed native adaptation, not implemented or qualified**. Task6a's Matrix host/source/CLI path is fixture-qualified; the offered ordinary OpenCode Chat routine path remains unfinished. Production routine bootstrap returns unavailable and preserves ordinary Chat. No native binary build, install, upstream PR, contact, account call or permission change is authorized by this document.

## Concrete incompatibility

The inspected upstream pin is OpenCode 1.16.0, commit
[6cb74317a6efacd656483cb0489d8e7e3701c12e](https://github.com/anomalyco/opencode/tree/6cb74317a6efacd656483cb0489d8e7e3701c12e).

[ConfigPaths.directories](https://github.com/anomalyco/opencode/blob/6cb74317a6efacd656483cb0489d8e7e3701c12e/packages/opencode/src/config/paths.ts)
always includes Global.Path.config and the home .opencode directory. OPENCODE_CONFIG_DIR adds a directory; it does not replace those roots. Project-disable removes project traversal only.
[ToolRegistry](https://github.com/anomalyco/opencode/blob/6cb74317a6efacd656483cb0489d8e7e3701c12e/packages/opencode/src/tool/registry.ts)
scans tool/tools JavaScript and TypeScript from all roots, follows symlinks and imports before ordinary native tool permissions can prevent module side effects.
Pure mode excludes external plugins, not this loader. Rejecting ambient files in a preflight does not close later discovery or writes.

Redirecting OPENCODE_TEST_HOME is not a transparent solution.
[Global](https://github.com/anomalyco/opencode/blob/6cb74317a6efacd656483cb0489d8e7e3701c12e/packages/core/src/global.ts)
uses that override for its home value.
[Instruction](https://github.com/anomalyco/opencode/blob/6cb74317a6efacd656483cb0489d8e7e3701c12e/packages/opencode/src/session/instruction.ts)
uses Global.Service.home for ~/.claude/CLAUDE.md and configured ~/ instruction expansion. Shell tilde handling separately uses os.homedir. An unchanged environment HOME string therefore does not establish preserved native home semantics.
[Auth](https://github.com/anomalyco/opencode/blob/6cb74317a6efacd656483cb0489d8e7e3701c12e/packages/core/src/auth.ts)
uses Global.Service.data/account.json and legacy auth.json; retaining XDG data is necessary but is not evidence of actual authentication compatibility.

## Smallest native seam

Propose an explicit **exclusive owned custom-tool directory** input to the native ToolRegistry loader, supplied through authenticated host bootstrap and immutable for that native child. This is a new API proposal, not an existing OpenCode CLI flag, config key, supported API or private-loader patch.

Only the custom-tool file loader would use the explicit singleton root instead of Config.directories. Ordinary config, instructions, Global.home, HOME, XDG data/state/cache, account/auth paths, model configuration, cwd/worktree, read behavior and session restore would keep their current resolution. Project config remains disabled according to Matrix's existing policy; pure remains enabled. This input must not be model-controlled or overrideable by user config, agents, tools, RPC bodies or a resumed session.

The native side must canonicalize and retain the exact host-owned directory, reject symlinks/alternate namespaces and duplicate matrix_routines definitions, and refuse unsupported input before loading custom modules. Matrix creates only its immutable tool resource in an exclusive 0700 run directory, with an exclusive 0600 file, then deletes it after source/process drainage. Untrusted same-UID code is not an isolation guarantee; the present trust ceiling remains explicit.

Do not move ordinary config wholesale to a private home. Do not import ambient tools, then filter their names. Do not widen shell/edit/write/task permissions, remove pure, migrate credentials, install hooks into user config, or use an upstream/private monkeypatch.

## Dependency readiness

The current native config loader schedules @opencode-ai/plugin installation for config directories and ToolRegistry waits for it when custom tools exist. The standalone owned module imports only node:net, node:crypto and node:string_decoder; it needs no plugin package or monorepo symlink. That alone does not suppress native dependency installation.

The proposed exclusive-loader path must explicitly bypass installation for this dependency-free owned tool, or require and verify an already packaged exact dependency set without network activity. Ordinary user config dependency handling is not a reason to run a new @latest install for routine enablement. Missing readiness must close this optional routine path before prompt submission; ordinary Chat continues without the routine tool. This is a required native API behavior change and needs separate approval/qualification.

## Matrix adapter and trusted call

The implemented host-only canonical execute scope captures actual owner, Computer, private Chat, turn, run and policy. Its retained child FD is never reconstructed from PID, socket name, latest session, model identity or a body source ID. The shared source producer explicitly validates the OpenCode run driver.

The host assigns the original user message ID. Actual native SSE events must establish the assistant's matching parentID, session and build agent, then a running matrix_routines event with matching messageID, callID and strict intent. The owned callback supplies native correlation only. Wrong session/message/call, missing event, changed intent, agent/cwd/worktree mismatch, duplicate callbacks or a closed generation cannot issue authority. The actual public callback must expose callID; the inspected public ToolContext type omits it although the registry spreads the underlying tool context. Native verification is mandatory.

The proposed adaptation must therefore also **explicitly expose the actual native-assigned immutable callID in the owned callback's public typed and runtime ToolContext contract**. This is a narrow additional native API contract, not an established supported property. It must equal the callID on that exact running tool event and remain tied to the same native session/message. The incidental current object spread is insufficient; missing/changed/guessed callID denies the callback. Neither a model argument nor a host-generated replacement is a substitute, and the correlation itself never grants Matrix authority.

Only the shared RoutineArgvSchema, fixed published matrix.mjs, private CLI IPC, source HTTP route, operation controller and canonical Postgres backend execute requests. Supervised mutations require the existing exact owner operation decision. Activation, background source consent and integrations stay separate. Native result/EOF/exit/Stop/steer/expiry fence source synchronously; result display and physical drain do not retain authority.

## Required parent-owned probe

Prerequisites: isolated credential-free runtime; exact cached immutable native source/package and executable; offline native dependencies/Bun when required; the separately approved exclusive-loader adaptation. Missing prerequisites, zero assertions or skipped required assertions fail the lane. No host native execution, new runtime download/install or real account/provider call is permitted merely to obtain a pass.

Use an offline local fake provider only if native public tool dispatch requires a model response. It may emit deterministic typed tool calls and must never return a fabricated Matrix receipt. The host controller/CLI/Hono/Postgres positive remains real.

Required assertions, all from the same native process/profile:

1. Verify exact package/executable/version/platform and adapted source fingerprint; reject arbitrary PATH binaries and unknown APIs.
2. Put throw-on-import marker modules in the original global tool/tools roots, HOME/.opencode/tool/tools roots and project .opencode roots. Every marker must remain unexecuted; prove positive instrumentation in a separate bounded fixture process, never by executing ambient code in a real owner environment.
3. Load the actual owned tool from its real 0700 directory through actual ToolRegistry. Require exactly one advertised matrix_routines tool and an actual public dispatch whose result is a string or output object accepted by native downstream processing.
4. Observe the actual session/message/parent/call events and held FD callback, cancellation, native result and late-call rejection. Require the approved public ToolContext declaration and runtime callback to carry the same immutable native callID as the observed running event; missing, altered, reused and cross-message IDs must fail. No incidental spread or fixture native identity may be promoted to this qualification.
5. Block network installation/package resolution; require native registry readiness and native-owned module import without monorepo symlinks or preloading host dependencies.
6. Compare ordinary and adapted config/instructions, HOME/Global.home/~/ expansion, cwd/worktree read/list behavior and restored session with an absolute home file and home instruction sentinel. Require identical expected semantics and no extra Bash/edit permission.
7. In a synthetic owner data directory only, verify native account.json/legacy auth path unchanged and credential files byte-identical. Never copy personal credentials. An auth path check does not establish account/provider acceptance.
8. Verify unsupported version/API/discovery/dependency fails optional routines closed while the original ordinary prompt runs once, with no replacement session, permission recovery or retry.

Record exact commands, exits, source/binary/resource hashes, platform, assertions, public native output types, offline network policy and cleanup. Linux and Darwin, each architecture, service-manager FD inheritance and installed packaging remain separate qualification tiers. No current cached native runtime was established, and none of these actual-native assertions has passed.

## Version and delivery implications

A native adaptation requires an explicitly reviewed pin/fingerprint and compatible packaging before Matrix can open its bootstrap gate. No installer/version policy changes are included here. Replacing @latest behavior, building a modified binary, upstreaming or shipping an adaptation is separate work. Fixtures cannot set an attestation bit to qualify production. The existing production unavailable result is an honest partial phase, not completed OpenCode support.
