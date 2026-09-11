# Local platform speech stack

Use the disposable fixture for normal local verification. It creates a new generated PostgreSQL role, platform database, owner database, runtime registration, runtime credentials, and temporary Matrix home. It does not reuse customer/runtime state, provision a VPS, call a speech provider, or debit funded-AI credit. Cleanup drops only identifiers with the `matrixos_speech_fixture_test_` prefix and removes its generated temporary home.

The fixture uses explicit loopback ports that do not overlap the normal development defaults:

| Service | Fixture port |
| --- | ---: |
| Web shell | 3117 |
| Gateway | 4117 |
| Platform | 9117 |

## Check out the published stack

PR #1620 contains the stacked foundation, UI, corrections, mobile, and consolidation commits. From a clean Matrix OS checkout:

```bash
gh pr checkout 1620
test "$(git branch --show-current)" = "codex/platform-speech-consolidation"
test "$(git rev-parse HEAD)" = "$(gh pr view 1620 --json headRefOid --jq .headRefOid)"
pnpm install --frozen-lockfile
```

If that branch is already checked out in another worktree, fetch it and use that existing worktree instead of forcing or rewriting it. A normal checkout of PR #1620 already contains the dependent PR commits; Graphite authentication is not required.

## Prerequisites

- Node.js 24+, pnpm 10, and bun
- PostgreSQL 16+ on the same computer
- A Chromium installation known to Playwright, or this repository's installed Electron runtime
- Linux headless verification: `Xvfb` when no display is already available
- `ffmpeg` only for owner-audio/channel formats; browser dictation records admitted PCM WAV directly

The repository development container normally exposes PostgreSQL through the local `matrix-postgres` container. Verify mode detects that container's configured PostgreSQL user without reading its password:

```bash
docker ps --filter name=matrix-postgres
bun run dev:speech:fixture -- --verify
```

For a different local container name:

```bash
export MATRIX_SPEECH_FIXTURE_POSTGRES_CONTAINER=my-local-postgres
bun run dev:speech:fixture -- --verify
```

### macOS with Homebrew PostgreSQL

The checked-in shell shim remains compatible with macOS stock Bash 3.2; supervision itself runs in Node.

```bash
brew install postgresql@16 ffmpeg
brew services start postgresql@16
export PATH="$(brew --prefix postgresql@16)/bin:$PATH"
export MATRIX_SPEECH_FIXTURE_POSTGRES_ADMIN_URL="postgresql://$(whoami)@127.0.0.1:5432/postgres"
psql "$MATRIX_SPEECH_FIXTURE_POSTGRES_ADMIN_URL" -c 'select version();'
bun run dev:speech:fixture -- --verify
```

The administrative role must be allowed to create and drop the generated role/databases. The fixture rejects non-loopback admin URLs before connecting. Do not point it at a hosted or customer database.
Direct local PostgreSQL administration uses a 5-second connection timeout and 10-second query/statement timeout. SIGINT or SIGTERM closes an in-flight administrative connection before cleanup reconnects with the same bounds.

## Deterministic verification

Run one command:

```bash
bun run dev:speech:fixture -- --verify
```

The command performs these bounded checks:

1. Confirms ports 3117, 4117, and 9117 are unused.
2. Creates new generated fixture databases, role, runtime registration, credentials, and home.
3. Proves that SIGTERM cancels an authenticated, in-flight local PostgreSQL query promptly, then runs exactly the five cases in `tests/platform/speech-postgres-concurrency.test.ts`, with one Vitest worker, against real PostgreSQL.
4. Builds shared prerequisites without speech credentials, then boots the real platform, gateway, and Web shell.
5. Requires an unauthenticated direct gateway request to fail and an authenticated same-origin shell request to succeed.
6. Blocks every non-loopback browser request before navigating the fixture UI.
7. Feeds a generated 16 kHz WAV through the browser microphone, records, stops, and requires exactly one transcription request.
8. Requires the deterministic transcript in the editable Web Mobile draft and a succeeded `dictation` operation in PostgreSQL.
9. Terminates all task-owned process groups and deletes the generated databases, role, and temporary home.

Any cleanup failure changes the command result to nonzero and reports only the failed cleanup stage; it does not print a database error or credential.

Success includes both lines:

```text
Verified bounded cancellation of an authenticated PostgreSQL query.
tests/platform/speech-postgres-concurrency.test.ts (5 tests)
Verified authenticated browser record -> stop -> fixture transcribe -> editable draft.
```

The browser may log that the disposable fake Clerk script was blocked. That request is intentionally denied before network access and is not a provider call.

After the command exits, optional cleanup checks are:

```bash
lsof -nP -iTCP:3117 -sTCP:LISTEN
lsof -nP -iTCP:4117 -sTCP:LISTEN
lsof -nP -iTCP:9117 -sTCP:LISTEN
ps -ax -o pid=,command= | grep -E 'dev-speech-(fixture|stack)|matrixos_speech_fixture_test' | grep -v grep
```

All four commands should produce no output. On Linux, `ss -ltnp` can replace the three `lsof` checks.

For an interactive deterministic stack, omit `--verify`:

```bash
bun run dev:speech:fixture
```

Open the printed Web shell URL and use Chat. Ctrl-C stops the three services and removes the generated fixture state.

## Credential isolation

`bun run dev:speech` builds the shared packages and starts platform, gateway, and Web shell. The Node supervisor passes `PLATFORM_SPEECH_OPENAI_API_KEY` and `PLATFORM_SPEECH_SECRET` only to the platform child. It passes both names with empty values to builds, gateway, and shell. Keeping the variables defined prevents the gateway's repository-root `process.loadEnvFile()` call and Next's `.env*` loader from repopulating them.

The runtime token is a machine/runtime-bound platform credential, not a provider key. It must never be placed in browser code or a `NEXT_PUBLIC_*` variable. The composed fixture obtains a short-lived browser WebSocket credential through the authenticated shell proxy; its generated long-lived gateway bearer remains server-side.

On early failure, SIGINT, or SIGTERM, the supervisor terminates every task-owned process group and escalates to SIGKILL after a bounded grace period so package-manager, `tsx`, and Next descendants do not survive. It returns the failed child's meaningful exit code, or 130/143 for SIGINT/SIGTERM.

## Real OpenAI gate

Real-provider testing is intentionally separate and was not performed by deterministic verification. It requires an operator-approved platform account, key, model, price, funding-source policy, and an already authorized local runtime with eligible credit. Confirm all values before opting in:

```bash
export NODE_ENV=development
export PLATFORM_SPEECH_ENABLED=true
export PLATFORM_SPEECH_PROVIDER=openai
export PLATFORM_SPEECH_OPENAI_API_KEY='<platform-only-key>'
export PLATFORM_SPEECH_MODEL='<verified-transcription-model>'
export PLATFORM_SPEECH_POLICY_REVISION='<reviewed-policy-revision>'
export PLATFORM_SPEECH_MICROUSD_PER_MINUTE='<verified-integer-price>'
export PLATFORM_SPEECH_FUNDING_SOURCES='addon'
export PLATFORM_SPEECH_SECRET='<separate-at-least-32-byte-local-secret>'
export PLATFORM_RUNTIME_MODE=local
export PLATFORM_DATABASE_URL='<local-platform-database-with-reviewed-runtime>'
export PLATFORM_SECRET='<local-platform-secret>'
export PLATFORM_PORT=9117
export PLATFORM_INTERNAL_URL=http://127.0.0.1:9117
export MATRIX_PLATFORM_SPEECH_ENABLED=true
export MATRIX_SPEECH_GATEWAY_PORT=4117
export MATRIX_SPEECH_SHELL_PORT=3117
export GATEWAY_URL=http://127.0.0.1:4117
export NEXT_PUBLIC_GATEWAY_WS=ws://127.0.0.1:4117/ws
export MATRIX_AUTH_TOKEN='<separate-local-gateway-bearer>'
export UPGRADE_TOKEN="$MATRIX_AUTH_TOKEN"
export MATRIX_HANDLE='<reviewed-runtime-handle>'
export MATRIX_MACHINE_ID='<reviewed-runtime-machine-id>'
export MATRIX_RUNTIME_SLOT=primary
export MATRIX_CLERK_USER_ID='<reviewed-owner-id>'
bun run dev:speech
```

Generate `MATRIX_FUNDED_AI_RUNTIME_TOKEN` through the normal local runtime-registration workflow. Do not copy a customer token or key, and do not put the OpenAI key in a runtime home, host bundle, gateway env file, renderer, or browser storage. `PLATFORM_SPEECH_FUNDING_SOURCES` may be `addon`, `promotional`, or `promotional,addon`; choose deliberately so a text-only campaign is not spent accidentally.

## Device and format gates

The automated composed check exercises the responsive Web Mobile renderer inside an owned desktop browser. It does not prove:

- microphone permission UX in Safari or Chrome on a physical phone;
- Native Mobile capture in the Expo dev client;
- Electron Desktop's packaged permission flow;
- a paid/real OpenAI transcription;
- channel voice-note conversion through a locally installed `ffmpeg`.

Run those only as separate, explicit gates. A physical device must reach the development computer over an approved LAN/HTTPS route; `127.0.0.1` on the phone points to the phone itself. Native Mobile requires the Expo dev client, not Expo Go. The bounded ffmpeg compatibility case is `tests/gateway/managed-speech-transcriber.test.ts` and verifies the converted RIFF/PCM shape accepted by the platform media inspector.
