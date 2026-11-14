# Publisher activation and live acceptance

[ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack),
existing DevStack stack. This is an operator procedure for the candidate described
in [spec.md](spec.md) and [source-run-recovery.md](source-run-recovery.md).
It does not authorize a deployment. Keep the populated host inventory, owner IDs,
UIDs, credentials, paths tied to an incident and captures outside this repository.

## Access and evidence

An observer may collect only the status/log commands granted to it. Record the
collector's `collectedAt`, instance/worktree, service state, health, restart count,
log availability and number of returned events. A forty-event capped summary is
neither a complete journal nor a revision-matched publisher receipt. A fresh
collection can contain old events. An observer cannot enroll, write source,
restart a runtime or install a publisher. Do not probe commands outside its grant.

The normal cloud CLI login and the browser Clerk session are independent of this
observer and of publisher activation. A browser takeover requires owner Resume
and then a fresh observation before automation continues.

## Reviewable inventory before any live write

The HEL1 operator must populate and approve one private inventory with:

| Item | Required value and check |
| --- | --- |
| Trusted code | Exact candidate commit/tree and immutable checkout; source uploads must not modify it |
| Main source | Canonical private worktree, exact Git base, production CLI fingerprint; baseline delta must be empty |
| Candidate resources | Unique instance/worktree/handle, preview and Gateway containers, ingress and publisher units, internal network and isolated Postgres database |
| Binding | Actual Clerk owner, runtime, worktree, handle, full 64-character container ID and Main source fingerprint; compare registry, CLI and publisher values |
| Publisher filesystem | Non-overlapping private staging Git checkout, projection mirror, journal/state directory, 0600 config and Unix socket |
| Identity | Dedicated non-root numeric UID/GID; publisher and ingress must see the same UID for the 0600 socket; uploaded workloads get no socket or host privileges |
| Dependency image | Reviewed digest, architecture, frozen-lockfile dependencies, fixed preview/test commands and actual startup evidence |
| Ingress | Exact hostname/path rules, private upstream, TLS/WebSocket behavior and saved previous rules |
| Approval | Distinct HTTPS origin, normal Clerk sign-in and signed JWT authorized party equal to that origin |
| Recovery | Candidate-only database DSN and migration authority; generation-two run schema; retention/lease and shutdown drain |
| Undo | Prior candidate-only configuration/registration, exact created resource IDs and evidence retention location |

Unknown values block activation. Historical preview Git bases and container IDs
must not be copied without checking them. Creating a new container changes the
binding: create it inert, capture its full ID, then enroll that ID before start.

## Identities and operator actions

1. **HEL1 operator:** use its existing authorized host-management path. Prepare
   the new candidate directories/account/units and an isolated runtime network;
   do not extend the observer's account or Docker rights. If a UID or daemon
   capability does not already exist, list that permission change for approval.
   Never attach a Docker socket, operational home, config, `.git`, state or
   database directory to uploaded preview/test code.
2. **Candidate database owner:** create the instance-specific local database
   `matrixos_devstack_<instance_with_underscores>`, initialize the existing
   DevStack identity/registration using `scripts/devstack-bootstrap.ts`, and
   register the actual candidate owner, handle, container and private ports.
   Use no production DSN, credits, billing mutation or peer registration. The
   candidate startup applies the additive generation-two run-store migration.
3. **HEL1 operator:** pin the service checkout and the staging checkout's exact
   Git base. The service code can be newer than that base, but the Main delta
   and staging HEAD must match exactly. Configure the publisher using the private
   schema in `stage3-preview-connect.md`. Compute local source and mirror
   identities with the production helpers; do not substitute the Main CLI
   fingerprint for the HEL1 staging identity.
4. **HEL1 operator:** review the preview's Docker arguments from
   `buildStage3PreviewPlan` before executing them. It only returns an argument
   array and does not deploy. Supply the registered handle: the plan sets the
   `matrixos-<handle>` network alias consumed by registered HTTP/WS routing. Use
   a new container and the approved internal network. That registration uses
   one host for both shell and Gateway ports: a separate trusted Gateway can
   join the preview container's network namespace, keeping its filesystem and
   environment separate. Enroll the namespace-owning preview's actual ID and
   verify both ports through the alias. Do not use two competing aliases or
   assume separate container names resolve to the registered host. Tests use
   `createIsolatedStage3TestRunner`: networkless, non-root,
   read-only mirror/root, disposable tmpfs and the fixed enrolled command.
5. **Candidate ingress operator:** launch trusted candidate ingress with the
   registered-runtime profile: `PLATFORM_RUNTIME_MODE=local`,
   `MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY=true`, its own
   `MATRIX_DEVSTACK_INSTANCE` and local `PLATFORM_DATABASE_URL`,
   `PLATFORM_BACKGROUND_WORKERS_ENABLED=false`,
   `MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED=true`, `CUSTOMER_VPS_ENABLED=false`,
   and no Preview-pair/ATS profile. Set candidate-only preview registration,
   `MATRIX_DEVSTACK_CLI_PILOT_WORKTREE`, and `MATRIX_DEVSTACK_SOURCE_PUBLISHER`
   with only `socketPath`, Main `identity` and `approvalOrigin`. Keep the socket
   and server settings outside the mirror. Use scoped candidate server secrets;
   do not copy production credentials into uploaded code or dependency images.
6. **HEL1 operator:** install and start only the candidate publisher and ingress
   units after reviewing their numeric identities, mounts and fixed executable
   paths. Publisher's trusted entrypoint is Node 24 running
   `scripts/devstack/stage3-publisher-service.mjs /absolute/private/publisher.json`.
   Keep provider credentials out of its environment. Do not restart the serving
   preview to activate this separate candidate.

Dependency-image qualification is an activation prerequisite, not a capability
proved by the existing filesystem-watch test. The image must resolve workspace
dependencies while watching the actual read-only mirror, write Next/build caches
to disposable storage, and run the real selected tests within the resource
limits. A plain Node image or a copied source tree with a detached watcher is
insufficient. `shell/next.config.ts` does not itself redirect `.next`; provide and
verify the reviewed image/cache layout before accepting the Docker plan. Stop
on read-only writes, unresolved dependencies or a full-reload-only update.

## Origin, DNS, Tunnel and Clerk changes

The current source-upload and result CLI deliberately allow only
`https://devstack.matrix-os.com`. A different candidate preview hostname is not
a drop-in deployment choice. Do not change local hosts or weaken the CLI origin
policy to bypass this constraint.

The Cloudflare/Tunnel operator must review exact candidate routing under that
existing hostname: the source/pair/poll/result family, the new worktree path,
and its actual runtime asset/HMR prefix. Direct only those approved paths to the
candidate ingress; retain existing peer worktree/default routing and upgrades.
If an active source-pairing consumer already owns the shared CLI paths, stop for
a coordinated plan; this single-pilot configuration must not silently replace it.

A separate approval HTTPS origin is mandatory. Reuse an already approved origin
only if it serves exclusively trusted approval code and satisfies the verifier.
Otherwise the DNS/Tunnel owner must approve a new hostname/record and route it to
the candidate ingress. The Clerk application owner must verify that normal
sign-in and redirect handling support this origin, making only the required
domain/redirect changes if absent. The candidate's separate verifier always pins
the signed authorized party to this origin. Main cloud CLI login does not replace
that browser proof. No new provider credential is inherently required by this
flow; any additional secret/config change needs its own reviewed scope.

Verify HTTP and WebSocket denial for every unrelated path on the approval host,
including when it overlaps the app-domain allowlist. Never serve editable assets,
service workers, runtime routes or operator APIs there.

## Same-agent acceptance after activation

1. Record the exact running code/image, owner and six-field binding. Collect
   observer state and peer-route baselines. Prove clean Main source and capture
   the initial content revision with an empty-delta sync.
2. Use the owner's normal Clerk browser approval on the trusted origin. Confirm
   the fingerprint and select only the candidate worktree. Keep the authenticated
   canonical worktree URL open; verify its Gateway and HMR connection. Establish
   visible component-local state that does not persist across reloads, such as
   a non-empty launcher search. Record its value and the initial page state.
3. From the same Main agent, make one uncommitted regular-source edit to a
   currently visible component. Run the candidate source CLI
   `matrix devstack sync --hosted --json`; keep its run ID and receipt in this
   Chat. Require matching `revision` and `test.revision`, actual exit code and
   bounded logs from the enrolled test command. Observe the changed UI without
   navigating/reloading; the local search/page state and URL must persist.
4. Make the second uncommitted edit and repeat. Keep distinct content revisions
   and matched test receipts. Capture both rendered states and document/HMR
   evidence; a filesystem watcher, old pilot or fixture identity is not enough.
5. Prove recovery with `matrix devstack result --hosted --run-id <uuid> --json`
   from a new CLI process and fresh normal approval, without another source POST.
   A missing/uncertain result must never cause an automatic re-upload.
6. Restore only this agent's changed source file to the recorded baseline and
   sync the empty delta. Require exact initial content revision, baseline test
   result and UI text, preserved page state, and a clean source worktree. Do not
   use a broad Git reset. Recollect observer/peer state and retain captures
   outside the repo; attach evidence to the PR and Slack with its exact build.

Candidate CLI commands come from the reviewed source checkout until a separate
release is qualified; the installed CLI version alone does not establish source
sync support. If the selected component is not mounted in the observed shell,
choose a visible component first rather than claiming success from hidden text.

## Rollback

The HEL1 operator first fences only candidate source admissions and drains its
bounded jobs. Restore only the saved candidate path rules/registration, keeping
the existing preview default intact. Stop the exact candidate ingress/publisher
units and remove only their recorded preview/test containers. Keep the staging
journal, source baseline and retained run receipts for inspection. An uncertain
projection requires journal reconciliation, not another blind publication.

The DNS/Tunnel and Clerk owners remove only entries introduced by this approved
candidate, after confirming no other consumer uses them. Retain generation-two
columns and records; do not reverse an additive schema while a process could use
it. Do not drop any database or remove the network/account/data without separate
cleanup approval. Verify the original preview, observer states and peer routes
against their preflight baselines. A failed acceptance keeps the PR draft and
leaves continuous sync, second-developer qualification and site-doc release open.
