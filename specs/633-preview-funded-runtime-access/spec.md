# Bounded funded access for PR Preview VPSes

Ticket: [ENG-348](https://linear.app/matrix-os/issue/ENG-348/featpreview-fund-bounded-ai-and-speech-on-preview-vpses). Status: implementation complete; live Preview verification pending reviewed control-plane deployment.

## Goal

A same-repository PR deployed as either a shared `preview` VPS or an owner-only `private-preview` VPS receives a short-lived, machine-generation-scoped allowance for Matrix-funded Chat and dictation. The allowance is independent of the owner's customer-primary balance, cannot unlock personal accounts for shared Preview users, and requires no manual host edit.

This is not production starter credit. Existing `provisioning_class=customer` plus `runtime_slot=primary` eligibility remains unchanged. A Preview is admitted only from an exact Platform database row whose server-authoritative class is `preview` or `private-preview`, together with its exact owner, machine ID, runtime slot, and runtime token epoch. A handle prefix alone never establishes Preview trust.

## Source of truth and data model

`preview_runtime_allocations` is the server-authoritative Preview allowance. Its primary key is the immutable machine ID; it records owner, runtime slot, token epoch, AI budget, AI and speech request counters, concurrency `1`, and expiry. It cascades when the machine is deleted. Every read or mutation joins or verifies the current machine generation, running/authorized state, Preview class, deletion state, and expiry.

Activation locks the exact machine row and performs the Preview allocation, AI policy, runtime balance, and expiring promotional grant in one transaction. The insert is one-time: rerunning activation reads existing counters and expiry and never refills, extends, or replaces the allowance. AI and speech request admission increment their respective counter with a guarded atomic update. Expiry, deletion, or token-epoch rotation makes credentials and allocations unusable immediately even if bytes remain on disk.

The separate `MATRIX_PREVIEW_RUNTIME_SECRET` must be at least 32 characters and must differ from `PLATFORM_SECRET`. Platform derives exact-machine, exact-slot, exact-epoch runtime tokens from it. The workflow and host receive only scoped derived tokens; provider keys and the Preview root secret never leave Platform or appear in workflow output.

Default and hard bounds:

| Control | Default | Hard bound |
| --- | ---: | ---: |
| Lifetime | 6 hours | 15 minutes–24 hours |
| AI budget | $1.00 | $0.000001–$5.00 |
| AI requests | 25 | 1–100 |
| Speech requests | 25 | 1–100 |
| Active operations | 1 | exactly 1 |

The AI dollar budget limits provider expense while the independent request counter limits many low-cost calls. Speech is zero-charge within its Preview counter and never falls back to the owner's paid or promotional balance. Preview funding summaries and speech capabilities return the remaining request count and expiry; Web Desktop, Web Canvas, and Electron Desktop render those values and retain the exhausted state.

## Auth matrix

| Route | Authentication and admission | Public |
| --- | --- | --- |
| `POST /vps/preview/access/activate` | `PLATFORM_SECRET`; bounded JSON body; exact DB owner/machine/slot/epoch; running, authorized, non-deleted `preview` or `private-preview` machine; feature opt-in | No |
| `POST /internal/ai/runtime/:handle/*` | HMAC token derived from `MATRIX_PREVIEW_RUNTIME_SECRET`, exact handle/machine/slot/epoch, plus active Preview allocation; production customer routes retain `PLATFORM_SECRET` | No |
| `/internal/speech/runtime/:handle/*` | Same exact-generation Preview token and active allocation; production customer routes retain `PLATFORM_SECRET` | No |
| Host funded-config and speech activation endpoints | Existing machine-scoped host control token derived from `PLATFORM_SECRET`; called only by Platform after exact DB admission | No |

Every mutating route uses `bodyLimit` and Zod validation. Secret comparisons use the existing timing-safe HMAC verification. Host calls use fixed HTTPS origins/IPs, redirect rejection, bounded bodies, ten-second request timeouts, a bounded readiness retry loop, and generic client errors. Logs contain error classes and coarse outcomes, never tokens or provider credentials.

## Workflow and runtime wiring

After deploying the exact PR bundle, `preview-vps.yml` reads `/vps/fleet` with operator authentication and requires one healthy machine whose handle and runtime slot equal `pr-<number>`, whose Platform classification is `preview`, and whose state is running and authorized. It posts the returned exact owner, machine ID, slot, and token epoch to the activation route. The workflow fails unless both host configurations are verified and both request allowances are positive with concurrency `1`.

An owner-only `private-preview` cannot use that branch workflow because it is provisioned from a reviewed bundle by the production Platform. Instead, its authenticated registration path persists a pending activation and invokes the same activator after the exact machine becomes running. The activator receives the registered row's owner, machine ID, runtime slot, and token epoch; failures leave funded capabilities unavailable, return only a generic registration warning, and remain pending for the bounded reconciliation worker. Retry is independent of the consumed one-use registration token, and stale in-flight activation claims are reclaimable after the reconciliation lease expires. Re-registration cannot refill or extend an existing allocation.

Only the existing same-repository, approved `preview-vps` execution path reaches this step. Fork PRs and unapproved workflow code receive neither production operator secrets nor Preview funded access. Replays do not mint a new allowance. PR teardown deletes the machine and cascades the allocation; the existing 72-hour reaper remains a second cleanup boundary.

Platform activation configures the host through the existing protected host endpoints:

1. Initialize or read the exact Preview allocation.
2. Post the exact Preview AI runtime token and fixed Platform/relay origins.
3. Have the real Gateway host handler re-read a short-lived Platform proof that
   joins the live Preview allocation and current machine generation, apply it
   through the root installer, and verify the host-reported revision.
4. Activate speech with a separately derived speech token for the same machine generation.
5. Return only coarse readiness and remaining counters to the workflow.

The control plane writes `MATRIX_PREVIEW_RUNTIME=true` into host configuration only when the persisted machine has `provisioning_class=preview` or `private-preview`; customer provisioning omits the marker. The runtime cannot top up a Preview allocation, inherit a configured owner promotion, or use checkout. Shared Preview users keep the existing denial for personal Integrations and Custom MCP accounts; funded Chat and dictation are machine capabilities, not personal-account delegation. Dictation accepts a non-owner only when the Gateway is an explicitly configured shared Preview runtime and Platform has supplied a verified collaborator principal after its live machine-access check. Private Preview remains owner-only at routing and machine access. Customer runtimes and direct non-Platform principals retain the exact owner check.

## Transaction, lock, and orphan-state rules

- Allocation creation takes the account-deletion owner lock first, then locks the exact machine and allocation/global/policy rows inside one transaction. A failed creation leaves no policy, balance, grant, or allocation.
- AI admission retains the existing funded-owner advisory lock and balance/reservation transaction, then atomically increments the exact allocation counter before committing the reservation.
- AI and speech admission share an exact owner/machine/slot advisory lock and
  check both durable active-operation registries while holding it. The Preview
  therefore permits only one funded operation across Chat and dictation, even
  for simultaneous hold-mode Chat requests or a cross-service race.
- Speech admission also retains the global speech admission lock, atomically
  increments the speech counter, and writes the operation/reservation in the
  same transaction.
- Host activation happens after the database commit. A host-config failure may leave an unused or partially consumed allocation, which is acceptable because the durable pending activation is retried independently and reruns are idempotent and cannot refill it. An allocation without both verified host configs is not reported ready.
- Expired allocations may remain as audit/accounting rows until machine or account cleanup, but all auth and mutation paths fail closed on expiry. Machine deletion cascades them; account deletion also deletes them explicitly.
- AI's existing owner-wide concurrency guard can be stricter than the Preview runtime's one-operation cap. It may defer a Preview request while another owner-funded request is active, but it cannot move or spend primary credit.

## Failure modes and operator controls

`MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED=false` is the default. Enabling it requires funded AI control-plane/runtime and Platform speech runtime to be enabled and requires Secret Manager secret `matrix-preview-runtime-secret`. Invalid limits, missing/deduplicated secrets, an ineligible machine, stale epoch, missing host address, host readiness failure, or exhausted/expired allowance fails closed.

Operators can disable new activation by turning off the feature flag. To revoke one Preview immediately, rotate its runtime token epoch or delete the machine; no host editing is required. Never print `host.env`, the Preview secret, derived tokens, speech provider keys, or relay provider credentials during diagnosis.

## Spec 530 boundary

This feature deliberately does not activate the Preview-owned routing and control-plane design from [spec 530](../530-per-pr-preview-hostnames/spec.md). Both shared and private PR Preview VPSes use the production Platform only as an explicit trusted control plane for an already server-classified Preview machine. No unmerged Platform revision, unrestricted credential, wildcard Preview route, personal Clerk session, or branch-controlled secret path is introduced.

If a future requirement needs Preview-specific Platform code to authorize or route funded access, spec 530's per-PR database, service identity, secrets, Clerk instance, DNS/TLS, and cookie/CSRF isolation must land first. Do not route that unmerged code through production as a shortcut.

## Acceptance and evidence

Focused Red → Green tests cover both server-authoritative Preview classes, bounded configuration, exact identity and epoch, owner-only Private Preview registration activation and durable retry after transient failure or a stale claim, one-time activation, AI and speech counters, concurrency, primary-balance isolation, cross-machine token rejection, expiry, deletion/recreation, workflow gating, migrations, contracts, and customer-path regression.

Merge readiness additionally requires one fresh exact-build Preview VPS created by `preview-vps.yml` and evidence for:

1. One real funded Chat turn and one real dictation transcription.
2. Before/after Preview counters and unchanged owner-primary funded balance.
3. Cross-machine/owner/slot replay denial and stale-generation denial.
4. Web Desktop, Web Canvas, and Electron Desktop quota/capability UI on the exact commit.
5. Fork/unapproved workflow denial, recorded from workflow policy rather than exposing secrets.

Attach the captures or accessible links to the PR, post the same evidence with ENG-348 and PR links in Slack `#tech`, and link the Slack permalink back to the PR. Record the exact commit/build and any fixture limitations. Do not commit evidence files.

## Documentation deliverables

- Update `docs/dev/preview-environments.md` and `docs/dev/pr-branch-preview-vps.md` with enablement, verification, revocation, and the spec 530 boundary.
- Open a separate public-safe documentation PR in `FinnaAI/matrix-os-site/content/docs/`. It may describe Preview quotas and user-visible behavior, but must not include secret names/values, customer identifiers, private hostnames, or operator credentials.
