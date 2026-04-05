---
name: integrations
description: Connect and use external services (Gmail, Calendar, Drive, GitHub, Slack, Discord) via Pipedream
triggers:
  - connect
  - integration
  - gmail
  - email
  - calendar
  - google drive
  - github
  - slack
  - discord
  - send email
  - read email
  - list events
  - create event
  - list repos
  - send message
  - connected services
  - oauth
category: system
tools_needed:
  - connect_service
  - call_service
channel_hints:
  - any
examples:
  - connect my Gmail
  - send an email to alice@example.com
  - what's on my calendar today
  - list my unread emails
  - post a message to Slack
  - connect my GitHub account
  - list my Google Drive files
  - disconnect Gmail
  - what services are connected
composable_with:
  - app-builder
  - build-crud-app
---

# External Service Integrations

Connect and use external services through Pipedream. The user connects via OAuth, then you can call APIs on their behalf.

## Available Services

| Service | ID | Actions |
|---------|-----|---------|
| Gmail | `gmail` | `list_messages`, `get_message`, `send_email`, `search`, `list_labels` |
| Google Calendar | `google_calendar` | `list_events`, `create_event`, `update_event`, `delete_event` |
| Google Drive | `google_drive` | `list_files`, `get_file`, `upload_file`, `share_file` |
| GitHub | `github` | `list_repos`, `list_issues`, `create_issue`, `list_prs`, `get_notifications` |
| Slack | `slack` | `send_message`, `list_channels`, `list_messages`, `search`, `react` |
| Discord | `discord` | `send_message`, `list_servers`, `list_channels`, `list_messages` |

## Step 1: Check Connection Status

Before calling a service, check if it's connected. If the user says "send an email" but Gmail isn't connected, guide them through connecting first.

## Step 2: Connect a Service

Use `connect_service` to start OAuth:

```
connect_service({ service: "gmail" })
connect_service({ service: "gmail", label: "Work Gmail" })
connect_service({ service: "google_calendar" })
connect_service({ service: "slack", label: "Team Slack" })
```

This returns a URL. Present it to the user -- they click it, authorize in their browser, and the connection appears automatically.

## Step 3: Call a Service

Use `call_service` to invoke actions:

```
call_service({
  service: "gmail",
  action: "send_email",
  params: "{\"to\": \"alice@example.com\", \"subject\": \"Meeting\", \"body\": \"See you at 3pm\"}"
})

call_service({
  service: "gmail",
  action: "list_messages",
  params: "{\"query\": \"is:unread\", \"maxResults\": 5}"
})

call_service({
  service: "google_calendar",
  action: "list_events",
  params: "{\"timeMin\": \"2026-04-05T00:00:00Z\", \"timeMax\": \"2026-04-06T00:00:00Z\"}"
})

call_service({
  service: "google_calendar",
  action: "create_event",
  params: "{\"summary\": \"Team standup\", \"start\": \"2026-04-06T09:00:00Z\", \"end\": \"2026-04-06T09:30:00Z\"}"
})

call_service({
  service: "github",
  action: "list_repos",
  params: "{\"sort\": \"updated\", \"per_page\": 10}"
})

call_service({
  service: "slack",
  action: "send_message",
  params: "{\"channel\": \"#general\", \"text\": \"Hello from Matrix OS!\"}"
})
```

## Action Parameter Reference

### Gmail

**list_messages**: `query` (string, Gmail search like "is:unread"), `maxResults` (number)
**get_message**: `messageId` (string, required)
**send_email**: `to` (string, required), `subject` (string, required), `body` (string, required), `cc` (string)
**search**: `query` (string, required), `maxResults` (number)
**list_labels**: no params

### Google Calendar

**list_events**: `timeMin` (ISO 8601), `timeMax` (ISO 8601), `maxResults` (number)
**create_event**: `summary` (required), `start` (ISO 8601, required), `end` (ISO 8601, required), `description`, `location`
**update_event**: `eventId` (required), `summary`, `start`, `end`
**delete_event**: `eventId` (required)

### Google Drive

**list_files**: `query` (Drive search), `maxResults` (number), `folderId`
**get_file**: `fileId` (required)
**upload_file**: `name` (required), `content` (required), `mimeType`, `folderId`
**share_file**: `fileId` (required), `email` (required), `role` ("reader"/"writer"/"commenter")

### GitHub

**list_repos**: `sort` ("updated"/"created"/"pushed"), `per_page` (number)
**list_issues**: `repo` (required, "owner/name"), `state` ("open"/"closed")
**create_issue**: `repo` (required), `title` (required), `body`, `labels` (comma-separated)
**list_prs**: `repo` (required), `state`
**get_notifications**: `all` (boolean)

### Slack

**send_message**: `channel` (required, "#channel" or channel ID), `text` (required)
**list_channels**: `limit` (number)
**list_messages**: `channel` (required), `limit` (number)
**search**: `query` (required)
**react**: `channel` (required), `timestamp` (required), `emoji` (required)

### Discord

**send_message**: `channelId` (required), `content` (required)
**list_servers**: no params
**list_channels**: `serverId` (required)
**list_messages**: `channelId` (required), `limit` (number)

## Multiple Accounts

Users can connect multiple accounts for the same service (e.g. Work Gmail + Personal Gmail). Use the `label` parameter to target a specific account:

```
call_service({
  service: "gmail",
  action: "list_messages",
  label: "Work Gmail"
})
```

## Error Handling

- **Service not connected**: You'll get an error with a connect hint. Guide the user to connect first.
- **Rate limited (429)**: Tell the user to wait and try again. The `retry_after` field tells you how long.
- **Timeout (504)**: The service took too long. Try again or simplify the request.
- **Service unavailable (503)**: Pipedream is temporarily down. Try again later.
- **Missing params (400)**: Check the required params for the action and try again.

## Common Patterns

### Morning briefing
1. `call_service({ service: "gmail", action: "list_messages", params: "{\"query\": \"is:unread\", \"maxResults\": 10}" })`
2. `call_service({ service: "google_calendar", action: "list_events", params: "{\"timeMin\": \"<today>T00:00:00Z\", \"timeMax\": \"<today>T23:59:59Z\"}" })`
3. Summarize unread emails and today's events

### Send and track
1. `call_service({ service: "gmail", action: "send_email", params: "..." })`
2. `call_service({ service: "google_calendar", action: "create_event", params: "..." })` (create follow-up reminder)

### Cross-service workflow
1. `call_service({ service: "github", action: "list_issues", params: "{\"repo\": \"owner/repo\", \"state\": \"open\"}" })`
2. Summarize issues and `call_service({ service: "slack", action: "send_message", params: "..." })` to post update

## Tips

- The `params` field is a **JSON string**, not an object. Always stringify.
- When listing items, use `maxResults` or `limit` to avoid overwhelming output.
- For Gmail search, use Gmail's query syntax: "is:unread", "from:alice", "subject:meeting", "after:2026/04/01".
- For calendar events, always use ISO 8601 datetime with timezone.
- If a service returns a lot of data, summarize it for the user rather than dumping raw JSON.
