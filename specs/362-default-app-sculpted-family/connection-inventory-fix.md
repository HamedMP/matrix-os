# Owner connection inventory in app windows

Subscriptions and the gallery were reading `/api/bridge/service` from the selected VPS. That legacy gateway route requires platform database and integration credentials, which customer VPSes do not have. Connection inventory is centrally managed by the platform.

Use the existing owner-authenticated `GET /api/integrations` in Web Canvas, Web Desktop, and Electron Desktop. The web parent resolves only this exact path against the platform origin, even when app data is routed through an explicit preview-computer prefix. Electron attaches the selected owner's credential in the main process. Installed app code never receives credentials.

| Route | Auth source | App capability |
| --- | --- | --- |
| `GET /api/integrations` | Existing platform owner session or native bearer identity | Canonical first-party starter inventory and gallery only |
| Other `/api/integrations/*` and mutations | Existing platform route policy | Not exposed through the app inventory bridge |

Preserve exact connection IDs, email and account labels; parse bounded inventory, strip extra fields in Electron, and fail closed on unavailable or malformed responses. Keep the existing ten-second timeout, no redirects, sender/origin checks and owner-generation invalidation. No new endpoints, credentials, database writes or import authorization are introduced. Imports remain explicit account-bound read-only kernel tasks.

Verification: central inventory routing with explicit preview prefixes; malformed inventory stays unknown; exact GET allowlists; main-frame sender and owner-generation checks; existing gallery installation and connected starter workflows.

Public documentation deliverable: update the app connection/import guidance in the private `FinnaAI/matrix-os-site` documentation PR when this gallery release ships.
