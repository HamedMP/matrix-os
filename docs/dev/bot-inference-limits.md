# Trusted Bot inference limits

The Gateway host can set `MATRIX_BOT_MAX_INFERENCE_CALLS` to a positive decimal
integer from 1 through 63 before starting its Bot services. This is a trusted
process configuration, not a Chat option, recipe field, tool argument or owner
billing policy. Ordinary Bot and Matrix AI Chat services use the same strict
parser and carry the limit in their broker-loaded worker specs. Native child
executors retain their separate controls.

When omitted, the existing tool budget remains 60 and the worker generation
ceiling remains 63. An empty, fractional, negative, space-padded or oversized value
fails service construction; it never falls back silently to 63. Values with a
final line terminator are also rejected. Changing the
value requires the normal reviewed configuration/deployment procedure. This
code change does not enable it on any machine. Tests lower the value only in
their own process. Do not activate a low value on a shared Gateway for one
person's acceptance; it would affect all ordinary coordinator turns there.
Use only a separately authorized owner/test Gateway configuration.

The caller places the ceiling in the broker-loaded run spec. The worker uses
the smaller of that ceiling and `maxToolActions + 3`. Main generation, accepted
steers and both compaction paths share it. Each dispatch consumes a slot before
calling the provider, including failed or aborted calls; SDK retries are
explicitly disabled. Exhaustion fails further main generation, while optional
summaries skip generation and retain the existing bounded session fitting.

The ceiling does not remove tools or history, lower the normal 8192-token
output route, or replace the separately guarded single-dispatch/256-token
isolated-turn mode. Existing broker authorization and output ceilings still
apply. Gateway and worker must be deployed from compatible sources because
older strict run schemas do not understand an explicitly configured ceiling.

This is a per-worker-invocation limit, not a dollar limit or a durable phase
allowance. A new canonical turn or user retry starts a new allowance. Native
child tasks, tool-mediated model work, readiness probes and other independent
inference paths do not consume it. Cost acceptance must separately qualify
those paths, live pricing, output bounds and the exact number of authorized
turns. A source/test result is not proof of installed runtime configuration.

Native ChatGPT subscription control delivery has a separately negotiated receipt
ledger (see `chat-run-limits.md`). A repeated poll re-delivers commands, not a new
generation: Native keeps the original inference and consumes no extra model-call
allowance for a duplicate. Cancel/ACK, source authorization and the original
inference/funding guards remain independent. This transport correction does not
raise tool, token, context, funding or per-worker-invocation budgets.

Worker progress projection uses a separate encoded-text budget (8 MiB per turn),
a 12 KiB encoded buffer and a serial awaited broker send. Timed updates continue
at 250 ms initially and one second after 1,600 text publications; they no longer
stop at a lifetime event count or wait for a full chunk. All 60 potential tool
lifecycles retain their own bounded progress allocation. Canonical Matrix Agent
output uses existing continuation messages under its same 8 MiB text budget.
These presentation/request guards do not refill the model session, context,
inference-call or funding allowance. See `chat-run-limits.md` for exact bounds.
