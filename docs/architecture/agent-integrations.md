# Updated Agent Integrations Architecture

## User experience

When a user connects Gmail in **Settings > Integrations**, that connection belongs to the Matrix user. New Hermes, OpenClaw, and coding-agent chats automatically receive a safe inventory entry such as `Gmail (Work Gmail, active)` and can use the Matrix integration tools without setup, skills, or provider credentials.

The inventory intentionally contains connection metadata only. Email content is fetched only when an agent performs an integration action.

## Boundary

Matrix exposes one stable integration boundary with these operations:

- list connected services
- start and synchronize OAuth connections
- describe supported service actions
- execute a validated action for one selected account
- disconnect an account

Pipedream remains behind this boundary for OAuth and provider-token custody. It is never configured separately in an agent or customer VPS.

## Agent delivery

All supported agent harnesses receive the same Matrix integration configuration during Matrix bootstrap. The integration skill is guidance for agents; it is not an authentication mechanism. The Matrix gateway remains the authenticated authority and resolves the user-scoped connection on every request.

## Comparison

| Area | Earlier state | Updated version |
| --- | --- | --- |
| OAuth | Platform-owned Pipedream routes | Same custody behind one Matrix boundary |
| Kernel | Direct IPC integration tools | Stable integration inventory and tools at chat start |
| Coding agents | Copied skill, no common runtime contract | Shared Matrix integration contract installed for each harness |
| Hermes and OpenClaw | Runtime-specific setup | Same user-scoped accounts and discovery flow |
| New chats | No guaranteed connection awareness | Safe connection metadata available automatically |
| Provider credentials | Never intended for VPSes, but paths varied | Never exposed outside the platform/broker |
| Apps | Existing bridge is not part of this update | Deferred; app permissions and SDK are designed separately |

## Security invariants

- OAuth tokens and Pipedream credentials stay platform-owned.
- Connection discovery returns labels, status, and email identity only; not provider data.
- Every action resolves account ownership server-side and validates the service, action, and parameters.
- Writes remain distinguishable from reads so harness policy can require confirmation.
- Provider errors are logged server-side and presented to agents as safe messages.

## Validation

Automated validation covers the integration contract, agent bootstrap configuration, and the desktop connection flow. A disposable Matrix VPS validates real OAuth, webhook delivery, user-scoped discovery, a representative read, a confirmed write, reconnect, and disconnect.
