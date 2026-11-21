# Spike 2691: a funded Pi turn through the container launcher

Branch `spike/2691-funded-turn` in `/Users/hamed/dev/claude-tools/matrix-os-2691-spike-funded`. Not pushed.

- `0229e917fd`: the harness
- `417712d8ca`: redacted run logs in `spikes/2691-funded/results/run1.log` and `run2.log`

## Verdict: pass

Pass condition: "Real funded chat turn with tool use completes; workload has no network and no gateway secrets."

Two runs passed. In each run:
- 4 turns used real Workers AI inference (`@cf/zai-org/glm-5.3-flash`) and every turn finished `completed`.
- Every content check passed.
- 29 of 29 isolation probes passed. The probes ran while the real worker and the gateway, which holds the secret, were still running.

This closes the S2 gap. The model was real, not scripted, and it was paid for through the Workers AI route.

## What ran

Container: OrbStack, kernel 7.0.11, arm64. It ran as uid 61184 with:
- `--cap-drop ALL` (CapEff 0) and `no-new-privileges` (NoNewPrivs 1)
- the S2 seccomp profile, which is Docker's default plus the user-namespace syscalls
- no `systempaths=unconfined`

The preflight therefore chose the non-hardened variant: no fresh `/proc` and no cgroup delegation.

**Real code:**
- **Supervisor:** the production entry `packages/scope-runtime/src/main.ts` with `MATRIX_SCOPE_RUNTIME_LAUNCHER=container`. It advertised `scope-runtime-bot-container-v1` and `scope-runtime-managed-pi-container-v1`. The runtime was created with the managed container profile and ran the bundled Pi bot worker under bwrap.
- **Gateway:** `createScopeRuntimeBrokerServer` and `forwardBotInference`, with access source `matrix_included`, action `inference.chat_completions`, and a bearer funded token plus the claim-key header.
- **Funded relay:** `serializeFundedOpenAiRequest`, the strict schema that sets `reasoning_effort: low` and `stream_options.include_usage`, and `normalizeWorkersAiResponse`.

**Stubbed:**
- the bot registry and authorizer
- the session store (in memory, with revision checks)
- artifact tool execution (S2's lstat and O_NOFOLLOW file helpers)
- the relay's platform authorize, reservation, start and settlement calls, and the funded admission queue

## Turns (run 1; run 2 matched)

Files the model had not seen were seeded with random values, so it could only answer correctly by using the tools.

| Turn | Tool actions | Inference calls | Prompt / completion tokens | Reply | Check |
|---|---|---|---|---|---|
| T1: write `notes/plan.md` | write | 2 | 1704 / 41 | `written` | file content correct |
| T2: read the seeded `data/code.txt` | read | 2 | 1840 / 25 | `MX-EECD4C8B` | matches the random code |
| T3: re-read `plan.md` after the owner edited it | read | 2 | 2013 / 27 | `COUNT=4 LAST=delta-b21f` | matches the edit |
| T4, multi-step: read numbers, sum them, write `sum.md`, read it back | read, write, read | 4 | 4682 / 92 | `SUM=270` | file holds 270 and the reply is correct |

Run 1 totals: 6 tool actions, 10 inference calls (all HTTP 200), 10,239 prompt and 185 completion tokens. Run 2 totals: 10,239 prompt and 188 completion tokens, with sum 289.

Approximate cost, using the repo's GLM Flash price snapshot of $0.15 per million input tokens and $0.50 per million output tokens: about $0.0016 per run, about $0.003 for both. The usage chunks report neurons, and those agree: about 11.3 neurons per 826 prompt tokens.

**Tool-call format: works with no adaptation.** Workers AI streams OpenAI `chat.completion.chunk` events with `tool_calls` deltas and `reasoning_content: null`. The funded relay's normalizer accepted them, and Pi parsed them.

Pi's request body has these keys: `max_completion_tokens, messages, model, store, stream, stream_options, tools`. The strict relay schema accepted it with no rejections, so production should not hit a request-shape failure on this path. Pi did not send `prompt_cache_key`.

## Inference path: direct to Workers AI, not through an AI Gateway

- A read-only list of the account's gateways failed with the wrangler OAuth token (Cloudflare code 10000).
- Using `gateway: { id: "default" }` would have created a gateway, so the Worker calls `env.AI.run` with no gateway.
- The account owner deployed the Worker `mx2691-funded-turn-spike` and set its secret.
- The Worker:
  - accepts only POST to `/v1/chat/completions`; other paths returned 404 and an unauthenticated POST returned 401
  - checks the secret header in constant time by comparing SHA-256 digests with `timingSafeEqual`
  - caps the body at 256 KB and output at 1024 tokens
  - serves the one model only

## Differences from the production route

1. **Transport.** Production calls the REST endpoint `api.cloudflare.com/.../ai/run/<model>` through an AI Gateway, using `cf-aig-gateway-id`, a Workers AI token, and log, ZDR and metadata headers. The spike called the AI binding directly from a Worker, with no gateway. The SSE format the binding returned is the one `normalizeWorkersAiResponse` expects, which suggests the REST route returns the same.
2. **No billing.** There was no reservation or settlement, and no admission queue.
3. **Output cap.** The route allowed 1024 output tokens; production allows 8192.
4. **Stubs.** The registry, authorizer, session store and tool executor were stubs.
5. **Probe placement.** The probes ran in a sibling sandbox, not inside the worker process itself. They used the production `probeContainerSandbox` and `buildContainerSandboxCommand` with the same seccomp program on fd 3, the same broker socket, the same worktree and the same umask. They ran while the real worker was alive (bwrap PIDs 52 and 53, worker PID 54). The model's only tools were the two artifact tools, so it had no way to probe from the worker itself.
6. **Platform.** arm64 under OrbStack, non-hardened variant (masked `/proc`), and only rlimits; no cgroup.

## Isolation probes: 29 of 29 in both runs

**Blocked:**
- **Network:**
  - internet TCP, UDP and DNS: `EAFNOSUPPORT` and `EAI_AGAIN`
  - the spike Worker's Cloudflare edge address on port 443
  - an HTTPS fetch to workers.dev
  - container loopback ports 4000 and 5432, and the container's eth0 address. These fail with `EAFNOSUPPORT` because the production seccomp filter allows only AF_UNIX.
- **Unix sockets:** `supervisor.sock`, the Postgres Unix socket, and the gateway's abstract socket.
- **Gateway secrets:**
  - The workload environment holds only `HOME`, `PATH` and `MATRIX_SCOPE_RUNTIME`.
  - The gateway's `/proc/<pid>/environ`, `/proc/1/environ` and the `/proc` scan all fail because there is no `/proc` in the view.
  - Signals to the gateway PID fail with `ESRCH`.
  - The broker refused the host-changing inference path (`@evil.example`) by dropping the frame.
- **Files outside the workspace:**
  - `~/system/secret.txt`, the owner home listing, and `/var/lib/matrix-scope-runtime`
  - `/etc/passwd`, the gateway bundle and `/opt/matrix/app`
  - a `../` escape out of `/workspace/project`
  - writes to the read-only bot runtime mount: `EROFS`

**Positive controls:**
- `broker.sock` is reachable.
- The workspace README is readable, and the model-written `notes/plan.md` is readable with the owner's edit.
- `/workspace` is writable.

**Leak scan on the gateway side:**
- The Worker secret, the funded token and the Worker hostname never appeared in any frame from the workload, any inference body sent to the workload, or the saved session.
- The probe output did not contain the secret.

**Expected log noise:** `seccomp program write failed` comes from the hardened preflight variant failing (EPIPE). It is expected under this profile.

## Cleanup

- **Worker:** still exists. Agents are not allowed to delete it. The owner should run this from `/Users/hamed/dev/claude-tools/matrix-os-2691-spike-funded/spikes/2691-funded/worker`:
  `CLOUDFLARE_ACCOUNT_ID=$(cat ../.local/account-id) wrangler delete --name mx2691-funded-turn-spike`
  Then delete the local folder: `rm -rf ../.local`
- **Secret:** the local secret file is deleted. The Worker's own copy goes away when the Worker is deleted. No secret, account id or Worker hostname is in git or the logs; I checked with grep.
- **Docker:** both containers ran with `--rm`, and no `mx2691-ft-*` containers remain. I removed the image `mx2691-ft-image`. Other agents' `mx2691-s1-*` images were not touched.
