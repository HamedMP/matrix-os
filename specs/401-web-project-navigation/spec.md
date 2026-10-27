# Web project navigation recovery

## Goal

Restore access to existing owner projects from Chat on Web Desktop, Web Canvas, and Web Mobile. Preserve company-drive authorization and existing project records.

## Journey

The signed-in owner opens Chat on a computer. Its Projects section requests that computer's owner-scoped `/api/workspace/projects` list. Opening a project reads canonical chats with the owner-scoped, project-filtered `/api/chats?projectId=...` cursor API for both its immutable id and legacy slug, so older chats outside the global navigation window remain accessible. Chats already in the navigation projection retain their rich row actions and start times; older rows open the same canonical transcript. As on Electron Desktop, a known project chat appears under its project only (search still finds it), and project chats show six at a time with Show more. Reloading the surface fetches the project list and opened project chats again. Empty lists and failed requests are explained in place, with retry for failures. Account or computer changes discard prior results.

## Acceptance checks

| Starting state | Action | Observable result | Failure/recovery | Boundary | Surface |
| --- | --- | --- | --- | --- | --- |
| Owner with project and chat | Open Chat, project, then chat; reload | Project and chat are visible and transcript opens | Reload refetches list | Gateway owner scope plus canonical Chat projection | Web Desktop, Web Canvas, Web Mobile |
| Owner with no projects | Open Chat | Clear empty state | New projects appear on next load | Current computer only | Web Desktop, Web Canvas, Web Mobile |
| Owner with 14 chats in a project | Open the project, then Show more | Six chats with start times, then all 14; chats are not repeated in the main list | Open chat stays visible past six | Canonical Chat projection | Web Desktop, Web Canvas, Web Mobile |
| Owner with an older project chat outside the global navigation window | Open project, load pages as needed, select chat; reload | Older chat remains discoverable and opens | Project page failure offers retry | Owner-scoped canonical Chat project cursor | Web Desktop, Web Canvas, Web Mobile |
| Owner request fails | Open Chat, retry | Error, then recovered list | No stale list from another owner | Current authority and routed VPS | Web Desktop, Web Canvas, Web Mobile |

## Risks

The Web Chat rail has no full project workspace. This change restores listing and project chat access without adding project creation, file browsing, or project management. Organization drives stay in their existing authorized section. Stakeholders should review the project grouping in the Chat rail.

## Read boundaries

Both project endpoints use the gateway's authenticated owner principal. The client validates response shape, caps chat pages at 100 and cursors at 512 characters, times out reads after 10 seconds, and aborts in-flight requests when a project closes or the account/computer changes. This change adds no writes or new route. The client presents a generic error with retry when a project page cannot be read.
