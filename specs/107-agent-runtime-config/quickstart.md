# Quickstart and Verification

## Worktree and Stack

Start each PR from the preceding stack branch in a dedicated manual worktree. Keep `/home/deploy/matrix-os` on `main`.

```bash
git -C /home/deploy/matrix-os fetch origin --prune
git -C /home/deploy/matrix-os worktree add /home/deploy/matrix-os.worktrees/<branch> -b <branch> <parent>
cd /home/deploy/matrix-os.worktrees/<branch>
gt track <branch> --parent <parent>
```

After the test-first implementation and review:

```bash
gt create -m "<conventional title>"
gt submit --stack
```

Each PR body includes [pr-invariants.md](./pr-invariants.md), exact focused/full test counts, and no references to UI inspiration material.

## TDD Loop Per PR

1. Add the focused test that expresses the branch contract.
2. Run only that test and capture the expected failure.
3. Implement the smallest production change.
4. Run the focused test to green.
5. Refactor while green, then run affected-package tests.
6. Run repository gates before review:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

For React branches also run React Doctor against changed React files. For the shell branch run:

```bash
bun run build:shell:production
```

Do not request merge until current-head CI is green and Greptile is 5/5 on the exact head SHA.

## Focused Contract Verification

### Conversation transcript

- Stored conversation returns its exact persisted transcript.
- Missing id is 404; malformed/traversal id is rejected.
- Store I/O failure is safe 5xx, not an empty transcript or not-found.
- Existing list/create/delete/search behavior remains green.

### Per-message model/effort

- WebSocket accepts each allowlisted optional field independently and together.
- Invalid/unknown values fail schema validation before dispatch.
- Dispatcher passes override into `KernelConfig` for one request.
- Following request without override resolves saved/default values.
- Channel, cron, and HTTP dispatch callers compile and behave unchanged.

### System information

- Explicit saved model is reported.
- Missing saved model reports the current kernel default.
- Malformed config follows existing safe config behavior and never reports `unknown` for a healthy default.

### Additive settings

- Legacy response fields and model/effort mutations remain byte-shape compatible.
- Extended response passes shared schema with capped catalogs.
- Omitted extended fields survive legacy writes.
- Runtime/provider mutation requires current revision and strict catalog membership.
- No key or secret canary appears in any GET/status/error response.

### Runtime transition

- OpenClaw missing/unhealthy leaves Hermes selected and Chat healthy.
- Successful switch pauses claims, drains/cancels, health-checks, commits, and resumes once.
- Each injected failure point rolls back to one runtime.
- Concurrent switches yield one winner and one safe conflict.
- Crash/startup reconciliation never enables duplicate delivery.

## Preview VPS Verification

Apply the `preview-vps` label before relying on preview checks. Record:

- PR number and exact head SHA.
- Host-bundle version and immutable bundle SHA.
- Preview computer runtime slot/label without publishing private host identifiers.
- Installed `/opt/matrix/app/BUNDLE_VERSION` and `/opt/matrix/release.json` version/SHA.
- `matrix-gateway`, `matrix-shell`, and selected runtime service status.
- Authenticated API response schemas and safe absent-runtime state.
- Canvas Agent settings loading, empty, error, auth, model, and save flows.
- Desktop older-gateway and current-gateway normalization evidence.

### Backend-stack route-precedence regression

On the preview computer associated with PR #919:

1. Resolve the deployed bundle to an exact source SHA.
2. Verify that SHA contains the #929 route-precedence fix and the #929–#935 backend-stack tip expected by the mobile stack.
3. Through the authenticated app route, create a terminal session with a safe test name, owner-home working directory, and harmless visible command.
4. Connect through the canonical terminal WebSocket, observe output, and close the session.
5. Repeat through the actual mobile provider install/login action so the terminal tab opens and connects end to end.
6. If step 2 fails, deploy an immutable bundle built from the exact backend-stack tip, verify installed metadata, then rerun steps 3–5.

The deployment trigger is not proof. Installed metadata plus successful API/WebSocket action is proof.

## Final Handoff Evidence

Report for every stacked PR:

- branch, PR URL/number, parent PR, exact head SHA;
- additions/files and conventional title;
- focused red failure and green count;
- full `typecheck`, `check:patterns`, `test`, React Doctor, and shell production-build results as applicable;
- current-head CI and Greptile 5/5;
- bundle version/SHA, preview label, installed release evidence, service/API/UI results;
- deferred work and any exact blocker.

Nothing is described as merged, shipped, promoted, or live until that state has been verified directly.
