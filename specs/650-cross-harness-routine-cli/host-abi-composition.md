# Host ABI composition for routine acceptance

## Current comparison

The [current #3104 comparison](https://github.com/HamedMP/matrix-os/pull/3104)
is based on the [Claude 2.1.280 hook layer #3097](https://github.com/HamedMP/matrix-os/pull/3097),
which follows the [routine reliability layer #3090](https://github.com/HamedMP/matrix-os/pull/3090).
The native ABI and rollback implementation is already in the current ancestry
through [merged #3101](https://github.com/HamedMP/matrix-os/pull/3101),
commit `a924c6174418a0834c0c3556a0143b5bb6825fad`. The Ubuntu 24.04 Preview
runner configuration is already present in main and matches
[#3103](https://github.com/HamedMP/matrix-os/pull/3103). This comparison only
records composition and acceptance evidence.

## Historical qualification receipt

The original qualification replay used #3097 at `0614dcb99a67` over #3090 at
`203bb805fe01`. It replayed #3101 as `b9027e84dfed` and #3103 as
`a586a6475eed`. The ABI replay had the same added and removed lines as its
supplier commit. The Preview replay had the same stable patch ID. These four
historical SHAs identify the run below.

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
