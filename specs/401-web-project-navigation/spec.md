# Web project navigation recovery

## Goal

Restore access to existing owner projects from Chat on Web Desktop, Web Canvas, and Web Mobile. Preserve company-drive authorization and existing project records.

## Journey

The signed-in owner opens Chat on a computer. Its Projects section requests that computer's owner-scoped `/api/workspace/projects` list. Opening a project fetches its chats through the canonical `/api/chats?projectId=...` route in pages of 100, including chats older than the global navigation window. Selecting a chat loads the existing transcript. Reloading the surface fetches the project list again. Empty lists and failed requests are explained in place, with retry for failures. Account or computer changes discard prior results.

## Acceptance checks

| Starting state | Action | Observable result | Failure/recovery | Boundary | Surface |
| --- | --- | --- | --- | --- | --- |
| Owner with project and chat | Open Chat, project, then chat; reload | Project and chat are visible and transcript opens | Reload refetches list | Gateway owner scope plus canonical Chat projection | Web Desktop, Web Canvas, Web Mobile |
| Owner with no projects | Open Chat | Clear empty state | New projects appear on next load | Current computer only | Web Desktop, Web Canvas, Web Mobile |
| Owner request fails | Open Chat, retry | Error, then recovered list | No stale list from another owner | Current authority and routed VPS | Web Desktop, Web Canvas, Web Mobile |
| Owner with older project chats | Open project, load more, select chat | Older chat opens even when absent from global Chat navigation | Failed page can be retried | Owner and project filter on gateway | Web Desktop, Web Canvas, Web Mobile |

## Security and runtime wiring

| Existing read route | Authentication and authorization | Input and response checks |
| --- | --- | --- |
| `GET /api/workspace/projects` | The authenticated shell route supplies a verified gateway principal; gateway principal supplies owner scope to the project manager. | Gateway validates `visibility`; Web validates project IDs, slugs and names before rendering. |
| `GET /api/chats?projectId=<id>&limit=100&cursor=<cursor>` | Same authenticated computer route; Chat service derives owner from the gateway principal and filters by validated project ID. | Gateway validates query, caps a page at 100 and encodes the next cursor; Web validates chat IDs, titles, page length and cursor before rendering. |

The Chat hook passes its mounted computer URL to the rail so shared-chat history changes cannot reroute reads. Both requests have a 10-second timeout. Account/computer changes, component unmount, and project collapse abort pending requests; identity checks prevent late project-list responses from appearing under a new owner. Errors show retry controls without exposing response bodies. This adds no write route, background worker, file I/O, lock, or new database state. The existing gateway owns pagination and project registry storage; the Web rail retains only loaded pages while mounted.

## Risks

The Web Chat rail has no full project workspace. This change restores listing and project chat access without adding project creation, file browsing, or project management. Organization drives stay in their existing authorized section. Stakeholders should review the project grouping in the Chat rail.
