# Project actions contract

| Route | Authentication | Public | Contract |
|---|---|---|---|
| PATCH /api/projects/:slug | Existing authenticated owner principal and collaboration write admission | No | Strict nonempty object with optional name, description, pinned; validated slug; 64 KiB body cap; returns {project} |
| Existing runtime project browse/read | Existing runtime auth and project scope checks | No | Reuse unchanged; renderer sends project slug and relative path |

Unknown keys, blank names, oversized strings, invalid boolean and empty patches return 400. Cross-owner/inactive projects return 404. Infrastructure failures return generic 500. No native filesystem IPC added. Metadata is not a realtime collaborative document; catalog refresh is authoritative.

Menus: Pin/Unpin, Edit, Open in Files, separator, Delete project. Ellipsis and context invocation consume the same descriptors. New Chat remains separate and rightmost. Delete opens current permanent-deletion confirmation.
