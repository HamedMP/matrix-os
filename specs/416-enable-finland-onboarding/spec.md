# Helsinki onboarding region

Ticket: [ENG-416](https://linear.app/matrix-os/issue/ENG-416/enable-finland-servers-in-onboarding)

## Goal and journey

Offer Helsinki, Finland (`hel1`) alongside the existing locations in the hosted computer picker. A user can select it, continue through checkout, and have the selected region accepted by prebilling and customer VPS provisioning. The picker groups Helsinki under Finland while retaining the `eu-central` network zone.

## Availability and machine shapes

Hetzner [lists `hel1` in `eu-central` with shared AMD cloud servers](https://docs.hetzner.com/cloud/general/locations/). Its [Germany/Finland product group](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) includes CPX22, CPX42 and CPX52. Use the existing EU Starter, Builder and Max shapes respectively. Individual server types can still be temporarily unavailable for ordering at the provider.

## Acceptance checks

- Helsinki appears under Finland in onboarding and can be selected.
- Checkout accepts `region_hel1`; the resulting placement resolves to `hel1` and the EU machine shape for each plan.
- Prebilling and customer VPS request validation accept `hel1`; unknown locations remain rejected.

## Deliverables

- This repository: shared catalog, checkout and provisioning validation, and the Web and Electron Desktop location pickers.
- Public docs (owned outside this repository): add Helsinki, Finland to the hosted server location list in the `FinnaAI/matrix-os-site` docs under `content/docs/`, as a separate docs PR. Owner: site docs maintainer. Follow-up issue: _to be linked by the owner_. Ship the docs PR together with the platform/app-shell deploy that publishes Helsinki, so the public location list matches onboarding.

## Risk and scope

The shared catalog is the source of truth for published regions. This change extends existing route schemas and provisioning validation; it adds no endpoint or persistence. Existing authentication, rate limits, and generic error handling continue to apply. Provider capacity is checked during provisioning, so checkout can still fail if a type is temporarily unavailable in Helsinki. A `MATRIX_RUNTIME_CATALOG_JSON` override replaces the default catalog; if it lists only region-specific profiles, it must add `region_hel1` entries (or region-less fallbacks), otherwise Helsinki is filtered out of allowed selections.
