# Existing private-preview Browser setup

Verified on 2026-10-20 at `pv-2687-22950040`. The optional native payload is from
`4a4e74802a8bbef379698a6ebaf6d3297d9d6aca`. The preview application remains
`v2026.10.17-pr2687-39024145844-1-cc96719`; it was not upgraded.

Before setup, all six Browser units were inactive and no Chrome profile existed.
After setup, all six units and the gateway were active, the installed manifest
reported ready, app-session and Browser-session creation succeeded, and the
viewer delivered frames without a socket error. Keyboard input through that
viewer navigated the fresh Chrome profile to example.com; the CDP target URL
independently confirmed the navigation. The three Browser service ports remain
bound to loopback. Configuration was backed up on the target before installation.

The screenshot and recording show the actual Chrome/Kasm viewer on that server.
The operator used the platform-derived per-machine credential retrieved through
Google Secret Manager, with HTTPS and the existing server certificate. Playwright
mapped app.matrix-os.com directly to this preview for viewer verification.
No Clerk user session or personal account login was copied. These captures do
not qualify the full Clerk-routed Web Desktop, Web Canvas, Electron or mobile
surfaces, agent takeover/resume, signed authority, passkeys, or managed Pi.

`live-before.json`, `live-after.json` and `viewer-check.json` contain only the
filtered checks. Credentials, cookies, tickets and private page content are
excluded. Full repository CI remains blocked by stale GitHub native-stack merge
metadata; this evidence does not waive that source gate.
