# Project actions contract

| Route | Authentication | Public | Contract |
|---|---|---|---|
| PATCH /api/projects/:slug | Existing authenticated owner principal and collaboration write admission | No | Strict nonempty object with optional name, description, pinned; validated slug; 64 KiB body cap; returns {project} |
| Planned GET /api/projects/:slug/files-location | Existing authenticated owner principal | No | Validated project slug; resolve eligible canonical directory; return home-relative Files path |

Unknown keys, blank names, oversized strings, invalid boolean and empty patches return 400. Cross-owner/inactive projects return 404. Infrastructure failures return generic 500. No native filesystem IPC added. Metadata is not a realtime collaborative document; catalog refresh is authoritative.

Menus: Pin/Unpin, Edit, Show in Files, separator, Delete project. Ellipsis and context invocation consume the same descriptors. New Chat remains separate and rightmost. Delete opens current permanent-deletion confirmation.

Planned contract (implementation pending): GET /api/projects/:slug/files-location uses the existing authenticated owner principal (not public), validates slug, rejects cross-owner/inactive projects, and resolves an eligible directory within the runtime home. Returns {path} as a home-relative Files location; missing/ineligible directory returns generic 404. No caller-supplied filesystem path.
