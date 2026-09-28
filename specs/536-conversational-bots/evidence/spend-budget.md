# Spec 536 live spike spend authorization

Recorded 2026-09-28 before provisioning or model calls. The owner authorized the lowest powered supported disposable VPS and a **USD 50 total cap** for S0 and Spikes A-C. This execution allocates at most USD 10 to VPS/IP charges and USD 40 to model calls; both allocations are subsets of the one USD 50 cap, not additional budgets. Stop before a category or total cap can be exceeded.

## Machine plan

- One preview VPS, `pr-2022`, requested by the `preview-vps` label on draft L11 PR #2022. The platform defaults to the supported CPX22 x86 plan (2 vCPU, 4 GiB RAM, 80 GiB disk). The exact public IPv4 in the platform fleet matched a Hetzner server record with type `cpx22`, status `running`, and creation time 2026-09-28T20:46:04Z. The preview workflow reaps `pr-*` machines after 72 hours and on PR close.
- Current published Hetzner rates: CPX22 USD 0.0368/hour plus primary IPv4 USD 0.0010/hour, excluding VAT. At 72 hours this is USD 2.7216 excluding VAT. Apply a conservative USD 10 machine/IP cap including tax and unforeseen charges; stop or delete early if needed. Sources: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/ and https://docs.hetzner.com/cloud/servers/primary-ips/overview/.
- Machine lifetime: 72 hours maximum per preview. Do not leave an unneeded preview running. Preserve it after validation only until the owner decides deletion, within the authorized cap.

## Model plan

- S0 live probe call cap: USD 2 within the USD 40 model allocation. The script estimates every recorded call, including compaction, using Claude Haiku 4.5 prices of USD 1 per million input tokens, USD 5 per million output tokens, USD 1.25 per million 5-minute cache writes, and USD 0.10 per million cache reads. Source: https://platform.claude.com/docs/en/about-claude/pricing.
- No real customer account, inbox, calendar, message recipient, or uncontrolled website is permitted. Use dedicated synthetic data and controlled accounts.
- After each stage, record actual provider usage and estimated costs. Do not treat a case without final usage as free. Track one cumulative total for S0 plus A-C before starting each subsequent call.

## Ledger

| Stage | Machine/IP USD | Model USD | Notes |
| --- | ---: | ---: | --- |
| S0 | 10.00 reserved | 0.007683 observed, 0.10 reserved | Preview `pr-2022` was created at 20:46:04 UTC as `cpx22` and is running; final provider charge is pending. Local package probe and one-token provider check; failed zero-usage attempts remain unbilled-unknown pending reconciliation |
| Spike A | 0.00 | 0.00 | Not started |
| Spike B | 0.00 | 0.00 | Not started |
| Spike C | 0.00 | 0.00 | Not started |

The S0 observation is below its USD 2 subcap. The USD 0.10 reservation conservatively covers the earlier calls that returned no usage; budget decisions use the reservation until provider reconciliation. The platform fleet confirms `pr-2022` was provisioned at 20:46:03 UTC on 2026-09-28 and is running. The matching Hetzner inventory record confirms the `cpx22` type and 20:46:04 UTC creation time. The full USD 10 machine allocation stays reserved until a provider charge or teardown receipt establishes the final amount.
