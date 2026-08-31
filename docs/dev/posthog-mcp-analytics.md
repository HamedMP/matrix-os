# PostHog MCP Analytics

Matrix instruments its in-process IPC and browser MCP servers with PostHog's official MCP analytics package. The gateway owns the existing PostHog client and lifecycle; each kernel-created MCP server is wrapped with that shared client, so there is no second telemetry queue or shutdown path.

Upstream references:

- [MCP analytics overview](https://posthog.com/docs/mcp-analytics)
- [Installation and instrumentation](https://posthog.com/docs/mcp-analytics/installation)
- [Privacy controls](https://posthog.com/docs/mcp-analytics/privacy)

## Package policy

`@posthog/mcp` is pre-1.0 and the PostHog documentation labels the feature beta. Matrix pins an exact version rather than taking a range. The current pin is `0.11.7`, the newest release that satisfied the workspace's seven-day `minimumReleaseAge` policy when this integration was added. Do not add a maturity-policy exception merely to take a newer MCP analytics release.

## What Matrix captures

PostHog receives the MCP event name plus a small allowlist of operational metadata:

- server, client, and protocol versions;
- tool name and optional low-cardinality category;
- duration;
- error boolean and low-cardinality error type;
- generated MCP session ID;
- Matrix service name.

This supports tool volume, error rate, and latency monitoring without tool content.

## What Matrix removes

The `beforeSend` hook is allowlist-based. It removes tool parameters, responses, resource names, tool descriptions, inferred or supplied intent, raw error messages, exception stacks, raw user-agent/vendor headers, conversation IDs, and any future property that has not been explicitly reviewed.

Matrix also configures the SDK with:

- `context: false` so no required analytics argument is injected into tools;
- `enableConversationId: false` so the agent is not asked to carry analytics state;
- `reportMissing: false` so no virtual tool is added;
- `enableExceptionAutocapture: false` so raw exception payloads do not fan out from failed calls.

The owner ID may be used as PostHog's distinct ID, but no person properties are attached by this MCP integration.

## Suggested PostHog views

Create three insights on `$mcp_tool_call`:

1. Calls over time, broken down by `$mcp_tool_name` and filtered by `service`.
2. Error rate using `$mcp_is_error = true`, broken down by `$mcp_error_type`.
3. p50/p95 `$mcp_duration_ms`, broken down by `$mcp_server_name` or tool.

Add these to the existing Matrix OS Errors dashboard. Configure spike or issue alerts in the PostHog UI; the repository alert bootstrap intentionally does not use an unstable public alerts API.

## Verification

With a PostHog project token configured, invoke one successful and one deliberately validation-failing MCP tool, then confirm:

- both calls appear as `$mcp_tool_call`;
- the failure has `$mcp_is_error = true` and a coarse error type;
- parameters, response content, intent, raw error messages, and `$exception_list` are absent;
- gateway shutdown flushes the shared PostHog client.
