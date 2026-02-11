# Event Stream Gateway

## Idea

The gateway becomes a bidirectional event hub -- not just kernel output streaming to the shell, but external events streaming INTO the OS. The user configures routing and actions through natural language conversation.

## Inbound event streams

External sources push events into Matrix OS:
- Customer support tickets (Intercom, Zendesk, email)
- Emails (IMAP, Gmail API, webhooks)
- Form submissions
- Stripe payments/webhooks
- GitHub issues, PRs, CI results
- Calendar events
- RSS/Atom feeds
- Custom webhooks from any service

Events arrive as a unified stream the kernel can reason about.

## User-defined routing via conversation

The key insight: routing rules are set by chatting, not configuring YAML files.

Examples:
- "When a support email comes in, summarize it and add to my dashboard"
- "If a Stripe payment fails, notify me immediately and create a follow-up task"
- "Route all GitHub PRs to the code review app I built"
- "For customer support tickets tagged 'billing', auto-draft a response and show me for approval"
- "Ignore marketing emails, but flag anything from investors"

These rules get persisted as agent knowledge files or a rules table in SQLite, so the kernel remembers them across sessions.

## Outbound actions

The OS doesn't just receive -- it acts:
- Send emails (SMTP, API)
- Post Slack/Discord messages
- Create GitHub issues
- Send SMS/push notifications
- Trigger webhooks to external services
- Update CRM records
- Schedule calendar events

User controls this the same way:
- "When build finishes, post to #deploys in Slack"
- "Email the client a status update every Friday"
- "If the health check fails 3 times, page me on PagerDuty"

## Architecture sketch

```
External services --webhook/poll--> Gateway /api/events
                                        |
                                        v
                                  Event queue (SQLite)
                                        |
                                        v
                                  Kernel evaluates rules
                                   /          \
                          Route to app    Trigger action
                          (custom UI)     (outbound API)
                                            |
                                            v
                                   External services
```

## Implementation considerations

- Events table in SQLite: id, source, type, payload, status, created_at
- Rules stored as markdown in ~/agents/knowledge/routing-rules.md or SQLite
- MCP tools for external services (Slack MCP, Gmail MCP, etc.)
- Notification preferences per user in ~/agents/user-profile.md
- Rate limiting and dedup on inbound events
- Approval flows: kernel drafts action, shows user, waits for confirm
- Event history viewable in shell as a timeline/feed app

## Connection to JSON Canvas idea

Event flows and routing rules could be visualized as a JSON Canvas -- sources on the left, routing logic in the middle, destinations on the right. User could even edit routing by manipulating the canvas.
