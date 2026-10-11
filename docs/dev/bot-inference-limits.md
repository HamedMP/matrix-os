# Trusted Bot inference limits

The Gateway host can set `MATRIX_BOT_MAX_INFERENCE_CALLS` to a positive decimal
integer from 1 through 63 before starting its Bot services. This is a trusted
process configuration, not a Chat option, recipe field, tool argument or owner
billing policy. It applies to ordinary Bot coordinator turns on that Gateway;
it does not configure ordinary Matrix AI Chat or native child executors.

When omitted, the existing tool budget remains 60 and the worker generation
ceiling remains 63. An empty, fractional, negative, padded or oversized value
fails service construction; it never falls back silently to 63. Changing the
value requires the normal reviewed configuration/deployment procedure. This
code change does not enable it on any machine.

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
