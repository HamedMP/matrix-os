# Host ABI composition for routine acceptance

## Exact sources

| Component | Reviewed source | Applied commit |
| --- | --- | --- |
| Claude 2.1.280 routine hook | Draft #3097 | `0614dcb99a672b152fda5ed3fe961a6b0b30d889` (base) |
| Native ABI and rollback repair | Merged #3101, `a924c6174418a0834c0c3556a0143b5bb6825fad` | `b9027e84dfed0ad2da45a5750f0cd0e7cdad8e1d` |
| Preview builder parity | Draft #3103, `11183466d817cabcae0d9b78a0c338ae9c2a24be` | `a586a6475eedb2ae9552dc0deb023868faac691e` |

#3097 retains its exact #3090 base
`203bb805fe0127d6b0a5a1d27540b01265aa05f1`. The #3101 cherry-pick applied
without conflicts. Its eight files have identical added/removed lines to the
supplier commit; surrounding branch context differs. The Preview patch has the
same stable patch ID as its standalone source.

## Interfaces and boundaries

This composition reuses #3101's staged native ABI verifier and rollback logic.
It does not add another verifier, persistence layer, scheduler or execution
identity path. The Preview build matches the supported Ubuntu 24.04 customer
ABI. CLI commands, revision controls, request identifiers and structured results
remain those of the routine stack.

Owner/Chat/Bot/run binding, foreground action approval, standing routine approval,
background model authorization and integration permissions remain separate.
Unsupported Terminal sources stay disabled. No background authorization is
enabled by building or installing this composition.

## Evidence and remaining acceptance

The six focused suites covering Claude hooks/commands, ABI validation, updater
recovery, bundle wiring and onboarding pass: 129 tests, zero skips. This is source
qualification. It does not establish a compatible rebuilt artifact or a real
routine lifecycle.

The active trusted Preview controller must first adopt the reviewed builder
repair through its existing rollout procedure. Source YAML in this branch
does not update that controller. Publish a fresh immutable test version without
channel promotion, verify its commit/checksum, install it on the selected test
Computer, then verify service/socket health and the real CLI → human approval →
canonical Matrix Bot execution path. Keep unknown/cancellation outcomes explicit.
Record the product demonstration only after that acceptance passes.
