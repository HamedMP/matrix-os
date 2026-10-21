# Browser setup on Private Previews

The Browser stack must be testable on an engineer's own `pv-<PR>-<suffix>`
computer. Installing the host bundle currently leaves the native Chrome/viewer
services absent; the earlier root installer additionally accepts only `pr-*`.

## Supported flow

1. Publish the cumulative Browser stack tip as a preview bundle, without a channel.
2. The engineer confirms that bundle with `matrix preview start <PR>` or
   `matrix preview update <PR>`. Verify the actually installed commit/version.
3. An authorized operator runs
   `sudo /opt/matrix/bin/matrix-install-browser-preview <exact-pv-handle> <machine-uuid> <owner-user-id>`
   **on that preview**. The helper and native payload ship in the host bundle;
   no checkout or laptop login copies are required. Legacy shared `pr-*` previews
   retain the single-handle command form.
4. Reopen Browser from the launcher and test navigation, a new snapshot, and
   Pause → Take over → Resume. Use the engineer's own connected agent account.
5. Supervised cards still require the separately reviewed signed-authority route.
   This installer does not enable that route or make Matrix AI funding runnable.

## Boundaries and wiring

- Root invocation and an exact match of the requested preview handle with the
  single `MATRIX_HANDLE` and `MATRIX_RUNTIME_SLOT` values are required. Accept
  canonical shared `pr-*` and owner-only `pv-*` IDs. Private previews also require
  an exact single `MATRIX_MACHINE_ID` and `MATRIX_CLERK_USER_ID`, with
  `MATRIX_USER_ID` absent or exactly matching the owner. Reject missing identity,
  primary, another preview, malformed IDs and duplicate metadata before locks,
  temporary files or service changes. Read metadata as data rather than sourcing
  it.
- Setup executes only the root-owned, non-writable payload installed through the
  normal verified host-bundle path. Never run privileged code from owner-writable
  `app/`. One host lock serializes setup; installation has a 30-minute bound.
- The build packages the React viewer and explicit native runtime files, excluding
  dependency stores, test probes, profiles and credentials. Ordinary host-bundle
  installation does not opt a computer into Chrome.
- Existing installations use the experience update, preserving Chrome/VNC PIDs,
  viewer credentials and the owner profile. A completion marker is written only
  after success; legacy installs require all six services to be running before
  choosing the update path. A first install leaves partial files on failure and
  can be retried, retaining a valid viewer credential pair and owner data. The
  installed app directory remains traversable by the unprivileged service even
  when the source payload was extracted into a root-only temporary directory.
- No new HTTP routes, grants, collaboration access, database writes, or default
  browser-permission activation. Customer promotion and fleet deployment remain
  outside this preview-only fix.

## Private Preview installation prerequisite

A clean Private Preview does not inherit an earlier VM's Browser Lab services.
The host bundle and the separately installed Browser Lab have distinct provenance.
Build the Lab frontend from the reviewed source before using its installer.

The installer accepts a legacy `pr-N` target only when handle and runtime slot
match exactly. A private `pv-N-<8hex>` target additionally requires the explicit
machine UUID and Clerk owner ID from the authenticated owner workflow. Before
any installation, its host environment must contain exactly one matching handle,
slot, machine ID and owner ID; an optional user projection must match that owner.
Missing, duplicate, malformed or mismatched identity fails closed. Do not rename
a private VM to impersonate a legacy preview or skip the guard.

Use the owner inventory and runtime identity to verify the target before
invocation. Installation affects only that target's browser dependencies, local
viewer configuration, services and gateway; existing non-root execution and
loopback listener restrictions remain unchanged. It does not change platform
IAM, account permissions or shared deployment configuration. Never log or export
the generated stream credential. Record both the host bundle commit and the
installer source commit in private acceptance evidence.

## Acceptance

- Reproduce the Private Preview rejection in both Node and privileged Python;
  pass canonical preview IDs with matching machine/owner identity while
  preserving the rejection controls.
- Extract a real staged archive and verify all runtime imports and prebuilt
  viewer files, with no dependency stores or private state.
- Exercise the packaged setup dispatch and existing-installation update in an
  isolated fixture. Fixture checks do not prove a live Chrome installation.
- On the exact engineer preview, verify installed source, app-session creation,
  Browser rendering and an agent's fresh second-turn snapshot before declaring
  the engineer unblocked. Web Desktop and Web Canvas need separate evidence;
  Electron Desktop needs a matching client and separate live qualification.
- Update the companion public Browser preview guide in
  `FinnaAI/matrix-os-site`. Ask the Browser/preview owner to review the setup
  contract; the user's instruction authorizes implementing this fix.

Tracking: [MAT-6](https://linear.app/matrix-os/issue/MAT-6/add-browser-use-support-to-matrix),
[native Browser stack #2689](https://github.com/HamedMP/matrix-os/stacks/2689).
