# Cloudflare compute admission qualification

[ENG-319](https://linear.app/matrix-os/issue/ENG-319/ship-shared-workspace-alongside-personal-vps-runtimes), 18 October 2026 UTC. Isolated preview resources only; no customer VPS or production routing changes.

## Exact build and scope

- Final runtime source: `66b1d0f30`; the Cloudflare checkout has the identical Git tree `8e05e2e85ca89db1c4286d35bf15af09db4c033b`. Subsequent reviewed head `4c175ecce` adds documentation only. The later interrupted-outcome fix is qualified separately with local PostgreSQL tests, not this cloud run.
- Final Worker runtime matches `66b1d0f30`; minute recovery cron was enabled.
- Native Linux amd64 image: `sha256:50640f0312d9fc32ab3b1e7a8110bed3ee460df60b04684492685d429f13c142`; actual Matrix gateway and Agent SDK `0.3.240`, Haiku 4.5. Container image runtime files are unchanged from foundation source `55e383275`; lifecycle and SDK environment policy ship in the Worker.
- Real Cloudflare Worker → Queue → Durable Object → native Container → actual Matrix gateway/SDK. R2 held immutable bytes, Hyperdrive connected isolated Postgres workspace data, and a separate isolated Postgres database held kernel state. No application D1/SQLite.
- One explicitly approved preview owner and test inference credential. This does not qualify a production multi-owner credential broker or public signup.

## Verified results

| Scenario | Observed evidence |
| --- | --- |
| Saved data without compute | Initial bootstrap 200 in 113ms, saved file 200 in 227ms, Chats 200 in 97ms; native metrics `running:false`, no reservations or runtime jobs. |
| Atomic admission and duplicate delivery | First POST and exact immediate replay returned the same job; one 300,000ms hold and one execution. A direct unadmitted Queue message was consumed successfully without creating a runtime job/reservation or waking a container. |
| Actual SDK restore | Two responses across native sleep/destroy/replacement used identical actual SDK session IDs and the same owner/Chat association. Both archives contained the SDK transcript. The second prompt contained no original random token and prohibited tools; the response recalled it exactly. |
| Real waiting tool on final policy | Fresh-Chat Bash `sleep 20` had a successful SDK tool result after **20,079ms**. The SDK tool input had no `run_in_background` field. Nine database samples during that interval all showed the job running with its full hold; lease expiry advanced **20,427ms**. |
| File publication and idle destruction | The foreground agent's exact text file was readable through the shared API, revision 1. Compute then stopped with held time zero. Submission HTTP connections closed after acknowledgement; no connected client owned the job lease. |
| Final quota denial | Server allowance reduced to zero: a new compute request returned **429**; completed exact replay returned **200/completed**. Bootstrap, original saved file, actual agent output and Chats remained 200 (86/174/165/123ms). No new outbox/job/user-input rows or debit; native metrics stayed false. Restoring the allowance preserved existing accounting. |
| Startup revocation, no inference | A real wake job was claimed, then trusted account suspension immediately fenced generation 6→7. Its reservation stayed uncertain, unsettled and fully held. **24,616ms** later confirmed native destruction settled the full 300,000ms hold. No output was published and the last checkpoint was unchanged. |
| Already-stopped recovery, explicit fixture | A typed Postgres admission/claim/interruption fixture simulated lost execution/termination acknowledgement **without starting native compute or dispatching a Queue job**. The actual Cloudflare minute cron and Durable Object recovered it after **23,319ms**. Native destruction on an already-stopped container succeeded; the conservative full 300,000ms settled and held time returned to zero. This is not a real process-crash injection. |
| Checkpoint integrity and secrets | All five downloaded archive hashes matched their R2 records. All six unique credential/connection values handled by the operator (including the staging admin credential) were absent from those archive contents. The final archive contained three SDK transcripts. Private session-authority paths returned 400 through the saved-file API. |

Session restoration was first qualified on `8058567a9`; initial quota/Queue checks ran on `5db6253dc`. Foreground execution, revocation, stopped recovery and the final quota/completed-replay check ran on `66b1d0f30`.

## Timing, memory and accounting

- Observer waits for the first and restored agent responses were **83.349s** and **44.841s**, including queueing/startup/checkpointing. The first timer started after admission, duplicate replay and a ledger snapshot; the second started after admission. These are not HTTP POST latencies or isolated gateway wake measurements. Their charged claim durations were 74.091s and 36.056s.
- The final successful foreground task charged **56.704s** from claim through durable completion and reached native sleep 79.554s after its admission response. Completion was first observed at 62.342s; the next observed sleeping state was 17.212s later (15s configured grace plus polling/stop overhead).
- Maximum sampled native VM used memory: **1,268,740,096 bytes (1.18GiB)**; maximum sampled gateway RSS: **758,028KiB (740MiB)**. Samples are not a continuous peak measurement. Shape remained `standard-2`, nominal 6GiB RAM/1 vCPU; no smaller shape was qualified.
- Exact inference costs for all five attempts, including unsuccessful workflows: **$0.04030775 + $0.01904230 + $0.02289135 + $0.02375485 + $0.04074830 = $0.14674455**. No further inference was run.
- Normal task accounting totaled **246,999ms**; two uncertain termination/recovery scenarios conservatively settled 300,000ms each. Final settled time was **846,999ms**, held time zero, against an explicit 900,000ms test allowance.
- Task allowance accounting does not include post-task idle or all provider allocation overhead. Inference, database, baseline, storage and networking are separate costs. This is not a measured total Free/Starter unit cost or a production allowance decision.
- Final checkpoint size was **963,059 bytes**; five downloaded snapshots ranged from 939,399–963,059 bytes. Their small size is specific to this test home, not representative of arbitrary customer apps or files.

## Failures and limits

1. The initial token/credential-themed prompt was declined by the agent. Its terminal response is valid session evidence, but it did not perform the requested tool/file work.
2. A later request saying “background job” used SDK Bash `run_in_background:true`; the model returned while its shell was detached, and the file did not survive checkpoint/teardown. This exposed the lifetime gap. The final pooled-only policy sets the documented `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; the final successful run confirms foreground behavior. Personal VPS policy is unchanged. Arbitrary manual shell detachment and durable background workflows remain unsupported rollout gates.
3. An explicit foreground retry in that existing Chat received a real SDK permission-denied tool result. No approval or safety policy was bypassed. A fresh Chat under the final policy succeeded. Recovery of already-cancelled/approval-blocked SDK sessions remains unqualified; this test does not identify which of the changed session/policy conditions caused that earlier denial.
4. Revocation was qualified during zero-inference startup, not during paid model/tool execution. Active-agent cancellation races have local tests; this report does not claim a live paid-agent kill test.
5. No two-owner isolation, generic app synchronization, account export/deletion, shared→personal migration, smaller runtime, production credential broker, or OS-view visual parity was qualified by these backend tests. Parent validation separately reports 268 local checks, including 22 real Postgres checks and 35 personal-routing regressions; no customer VPS deployment occurred.

## Cleanup

Cleanup completed and absence verified after qualification. The isolated container application had **zero live instances** before removal. Removed:

- One Worker with its four hosted secrets, one native container application and its associated Durable Object namespace.
- Both Queues and the Queue consumer, one Hyperdrive configuration, and one R2 bucket after deleting **12 objects / 9,505,408 bytes** (10 checkpoints and two saved text files).
- Both disposable Postgres databases and roles; database/role absence was queried through the existing staging administrator.
- One registry image tag and both task-owned local image tags.
- The private operator directory with 107 credential/config/archive/log/helper files, and 32 task-owned Wrangler debug logs. No exact secret values were found in those CLI logs.

Cloudflare returned not-found for the Worker, native container application, Queue, Hyperdrive and bucket; list checks found neither Queue nor the associated Durable Object namespace or registry tag. Native compute was zero before deletion. Owned helper/tail processes were stopped, the cloud source worktree is clean, and only this public-safe report was retained. Shared CLI login, the existing user keychain, original source credentials and global Docker build cache were preserved. Provider-managed image/cache retention was not inspected or purged; no total billing claim is made.
