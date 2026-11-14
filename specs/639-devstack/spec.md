# Isolated hosted source publication

Task: [ENG-432](https://linear.app/matrix-os/issue/ENG-432/build-a-reusable-multi-worktree-devstack).
Continue draft [#3277](https://github.com/HamedMP/matrix-os/pull/3277) and the existing DevStack stack.

The Main Computer agent edits its own uncommitted Git worktree. A short-lived,
Clerk-approved grant sends its bounded delta to a dedicated HEL1 publisher. The
publisher stages it privately, projects an owner-bound source mirror, and runs
the enrolled tests in a disposable container. The separate preview consumes the
same mirror through a read-only bind mount; its development server watches that
mount directly so browser HMR can preserve state.

## Trust and wiring

1. Ordinary Platform startup and Stage 2 remain unchanged without the explicit
   `MATRIX_DEVSTACK_SOURCE_PUBLISHER` opt-in. Extract hosted access construction
   from the large startup entrypoint into `devstack-hosted-access.ts`.
2. The opt-in JSON contains only `socketPath`, enrolled CLI `identity`, and
   `approvalOrigin`. It requires an existing public pilot worktree. Never accept
   host paths, test commands, owners, or container selections from an upload.
3. A separate HTTPS approval origin serves only the bounded pairing approval
   routes and Clerk sign-in document. Deny every other path there before any
   Platform handler or runtime proxy. Browser POST requires that exact Origin;
   preview-origin approvals fail. A separate Clerk verifier requires a signed JWT
   `azp` equal to the approval origin, rejecting preview-token replay even when a
   server caller forges Origin. The preview verifier remains unchanged.
   Pair/poll/source remain on the preview origin
   and carry no browser approval authority. No CORS access is granted.
4. A dedicated trusted publisher process reads a private 0600 operator config.
   It imports only trusted code, clears inherited environment on executable
   startup, and never runs uploaded code on the host. The private staging Git
   checkout, journals, IPC socket and service checkout are absent from workloads.
5. Ingress connects through a 0600 Unix socket inside a canonical owner-only
   directory. Both sides pin owner, runtime, worktree, handle, container ID and
   source fingerprint. Callback challenges make ingress recheck live Clerk
   membership, token expiry and runtime registration at the receiver's existing
   staging/publication/result boundaries. No cookies or bearer reach publisher.
6. The sole publisher holds source/target locks through testing. Concurrent
   requests fail busy; the mirror's revision cannot advance while its test runs.
   Tests receive only a read-only mirror and disposable writable tmpfs copy.
   They run as the non-root service UID, without networking, capabilities, host
   sockets or host credentials, under resource/time limits. Clear image-defined
   environment as well; use only a reviewed digest-pinned dependency image.
   `buildStage3PreviewPlan` produces Docker create arguments without starting
   anything: a verified owner-only mirror, read-only source/root, cleared
   environment, tmpfs build output and an existing internal Docker network.
   Ingress joins that network; no workload host port is exposed. Its reviewed
   dependency image must run the dev server directly against `/source`, with
   caches/build output redirected to `/tmp`, to retain source-watch events.

| Boundary | Authority | Rejected input |
| --- | --- | --- |
| Pair/poll | Existing bounded pairing identifiers and exact preview host | Wrong source fingerprint, spoofed host, cross-origin POST |
| Browser approve | Trusted origin, verified Clerk session, current membership, exact live target | Preview-origin approvals; runtime/assets/service workers on approval host |
| Source POST | Scoped short-lived bearer plus live checks | Oversized/invalid delta, stale owner/worktree/runtime/container |
| Publisher IPC | Private same-UID socket plus pinned binding and live challenges | Extra binding fields, arbitrary paths/commands, invalid frames/deltas |
| Test container | Operator-pinned image and command only | Network, mirror writes, credential/host mounts |

## Failure and resource behavior

The existing Git staging journal and source projection manifest remain filesystem
transport state, not new app-record storage. Partial staging/projection failures
retain their existing operator-recovery semantics. Never blindly retry an unknown
publication. A test failure returns its actual exit code with a matching content
revision; it does not replace source or advance another revision.
An incoming HTTP disconnect closes the private publisher socket and cancels its
test, releasing the publication slot after cleanup. Cancellation after projection
does not roll back uploaded source; the caller must reconcile that uncertain
publication before another deliberate change. All WebSocket upgrades on the
approval hostname are denied before runtime routing, including trusted edge
forwarding and an overlapping app-domain allowlist.

IPC caps four connections, one active publication, 4 MiB delta frames plus bounded
binding overhead, 32 KiB result frames, sixteen live-check exchanges and a 120 s
deadline. Checks have a 10 s deadline. Disconnect aborts the test runner; shutdown
closes clients, drains jobs, and removes only the owned socket. Tests run at most
90 s with 2 GiB RAM, 2 CPUs, 128 PIDs, bounded logs, read-only root, and size-limited
tmpfs. Always remove that exact disposable container after timeout/cancellation.
No new database pool, public endpoint family, schema migration or stored grant.

## Acceptance

| Actor / action | Observable completion | Failure / boundary | Lane |
| --- | --- | --- | --- |
| Main agent sends two uncommitted deltas then empty delta | Distinct content revisions and matching test logs; exact baseline restored | Six binding fields fenced; revocation before publish preserves mirror | Real Unix client/receiver integration; fixture identity clearly labeled |
| Uploaded test probes host/network/mirror | No operational canary, no host sockets, loopback only, EROFS on mirror | Nonzero exit preserved; timeout/cancel removes container | Required real Docker lane; no missing-prerequisite skips |
| Owner approves in normal HTTPS browser | Approval succeeds only on trusted origin, then returns to exact preview URL | Preview origin cannot approve or load editable code on trusted host | Route tests; real Clerk browser acceptance still required |
| Same agent edits twice on Main | HTTPS preview HMR preserves URL and local page state; both exact revision logs reach original Chat; rollback restores baseline | Wrong owner and stale binding denied; peer preview preserved | Live HEL1 Web Desktop, screenshot and recording required |

Web Desktop's hosted approval/preview is affected. Electron, Web Canvas, Web
Mobile and Native Mobile can open the same external browser flow; no renderer or
native UI implementation changes here. Their applicability and any N/A rationale
need reviewer confirmation, not inference from a desktop screenshot. Live evidence
is still required before review readiness. Suggest engineering/security review of
the publisher boundary and the separate approval origin before activation.

## Activation gate and rollback

No live rollout is authorized by this spec. Present the exact host, service UID,
socket/config paths, pinned image digest, new approval hostname, Clerk origin,
Tunnel route and isolated preview binding to Yuhan before changing infrastructure,
DNS, Tunnel, permissions or credentials. Use a new candidate runtime and source
mirror; never repurpose the serving checkout/overlay or peer registrations.

Rollback disables only the candidate publisher opt-in, stops its service and
candidate containers, restores only its prior registration/config, and removes
only approved new ingress/DNS/Clerk entries. Preserve journals and previous source
for inspection. Do not change Main services, Fast CI, Stage 2 or existing Preview.

Retained source-content results use the existing Postgres run store as described
in [source run recovery](source-run-recovery.md). The recovery-capable CLI saves a
run UUID/key before upload and can read that same run from another process. This
is separate from the old Git-revision operator-run API. Continuous sync and live
owner/browser qualification remain outstanding. No JSON/SQLite result store.

Update the separate `FinnaAI/matrix-os-site` documentation PR (existing #339 where
appropriate) after live qualification. Do not publish a claim of working hosted
sync before the real account/browser acceptance passes.
