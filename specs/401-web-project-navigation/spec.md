# Web project navigation recovery

## Goal

Restore access to existing owner projects from Chat on Web Desktop, Web Canvas, and Web Mobile. Preserve company-drive authorization and existing project records.

## Journey

The signed-in owner opens Chat on a computer. Its Projects section requests that computer's owner-scoped `/api/workspace/projects` list. Opening a project reveals its chats from the canonical Chat navigation projection; selecting a chat opens the existing transcript. Reloading the surface fetches the project list again. Empty lists and failed requests are explained in place, with retry for failures. Account or computer changes discard prior results.

## Acceptance checks

| Starting state | Action | Observable result | Failure/recovery | Boundary | Surface |
| --- | --- | --- | --- | --- | --- |
| Owner with project and chat | Open Chat, project, then chat; reload | Project and chat are visible and transcript opens | Reload refetches list | Gateway owner scope plus canonical Chat projection | Web Desktop, Web Canvas, Web Mobile |
| Owner with no projects | Open Chat | Clear empty state | New projects appear on next load | Current computer only | Web Desktop, Web Canvas, Web Mobile |
| Owner request fails | Open Chat, retry | Error, then recovered list | No stale list from another owner | Current authority and routed VPS | Web Desktop, Web Canvas, Web Mobile |

## Risks

The Web Chat rail has no full project workspace. This change restores listing and project chat access without adding project creation, file browsing, or project management. Organization drives stay in their existing authorized section. Stakeholders should review the project grouping in the Chat rail.
