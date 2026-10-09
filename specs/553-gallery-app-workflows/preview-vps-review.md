# Gallery review VPS

## Scope

Combine the connected-app workflow and identity stack (#2253, #2258) with the reviewed default-app sources (#2234, #2254) on one disposable PR preview computer. The source is pinned to the integration PR head. The public site and simulated Chat journey remain separate review surfaces; no production Chat cards, ratings, or mobile qualification are claimed.

## Deployment

Use the trusted Preview VPS workflow, register the exact bundle with channel `none`, and deploy only to this PR's preview handle. No channel promotion or primary-computer update. Use synthetic records on the shared preview; connected personal accounts require a separately authorized Private Preview. Existing account bindings, app permissions, and owner Postgres authorization remain unchanged. No new endpoint or persistence schema is introduced.

## Acceptance

- Build the production host bundle and record its exact version and source SHA.
- Verify authenticated runtime access, gateway and shell health, and app inventory.
- Open App Gallery from the launcher; inspect distinct identities, purpose-specific layouts, and narrow integration requirements.
- Install representative personal and business apps, save a synthetic record, reopen it, edit it, and export it.
- Check Web Canvas, Web Desktop, Electron Desktop access, and Web Mobile layout; Native Mobile device qualification remains a separate required gate.
- Preserve failed save/import drafts and verify retry behavior; do not describe a queued import as completed.
- Verify personal-account denial on the shared preview. Do not import owner emails into a shared review environment.

## Lifetime and docs

The workflow deletes the computer when the integration PR closes; the daily reaper enforces a 72-hour limit. Keep the preview while review is active. Public journey documentation is in FinnaAI/matrix-os-site#195. Update this file with actual checks and outstanding issues; pending checks are not passes.
