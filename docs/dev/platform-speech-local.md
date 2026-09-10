# Local platform speech stack

The root `dev` command intentionally does not start the platform. Use `bun run dev:speech` from a speech worktree to build the shared prerequisites and run the platform, gateway, and Web shell together. The launcher keeps `PLATFORM_SPEECH_OPENAI_API_KEY` and `PLATFORM_SPEECH_SECRET` in the platform process; it removes both variables from the gateway and shell process environments.

This workflow requires the normal local platform prerequisites: Node 24+, pnpm 10, a local Postgres database in `PLATFORM_DATABASE_URL`, a non-default `PLATFORM_SECRET`, and a disposable/local runtime already registered in that database. The gateway identity variables must name the same running, authorized `user_machines` row:

```bash
export PLATFORM_RUNTIME_MODE=local
export PLATFORM_DATABASE_URL=postgresql://localhost/matrixos_platform
export PLATFORM_SECRET='<at-least-32-byte-local-secret>'
export PLATFORM_INTERNAL_URL=http://localhost:9000
export MATRIX_PLATFORM_SPEECH_ENABLED=true
export MATRIX_HANDLE='<local-runtime-handle>'
export MATRIX_MACHINE_ID='<local-runtime-machine-id>'
export MATRIX_RUNTIME_SLOT=primary
export MATRIX_CLERK_USER_ID='<local-clerk-user-id>'
export MATRIX_FUNDED_AI_RUNTIME_TOKEN="$(node --input-type=module -e 'import {createHmac} from "node:crypto"; process.stdout.write(createHmac("sha256", process.env.PLATFORM_SECRET).update(JSON.stringify(["matrix-funded-ai-runtime",1,process.env.MATRIX_HANDLE,process.env.MATRIX_MACHINE_ID,process.env.MATRIX_RUNTIME_SLOT])).digest("hex"))')"
```

The runtime token is a machine/runtime-bound platform credential. It is not the OpenAI key, and it must not be placed in browser code or a `NEXT_PUBLIC_*` variable.

## Deterministic fixture mode

Fixture mode is for local design and lifecycle testing only. It never calls a provider or debits the funded-AI ledger, and startup rejects it when `NODE_ENV=production`.

```bash
export NODE_ENV=development
export PLATFORM_SPEECH_ENABLED=true
export PLATFORM_SPEECH_PROVIDER=fixture
export PLATFORM_SPEECH_POLICY_REVISION=local-fixture-1
export PLATFORM_SPEECH_FIXTURE_TRANSCRIPT='Deterministic local transcript'
export PLATFORM_SPEECH_SECRET='<a-separate-at-least-32-byte-local-secret>'
bun run dev:speech
```

Open Chat at the printed shell URL. In Web Canvas, Web Desktop, or the responsive Web Mobile layout, type text and add an attachment before recording. Start and stop the microphone: the fixture transcript should be inserted into the existing draft without sending it, changing the attachment, or overwriting intervening typing. Cancel should insert nothing. Deny microphone permission once to verify the safe error and track cleanup, then grant it and retry.

## Real OpenAI mode

Real mode has no provider, model, price, or funding-source defaults. Use values verified for the platform account and operator policy:

```bash
export NODE_ENV=development
export PLATFORM_SPEECH_ENABLED=true
export PLATFORM_SPEECH_PROVIDER=openai
export PLATFORM_SPEECH_OPENAI_API_KEY='<platform-only-key>'
export PLATFORM_SPEECH_MODEL='<verified-transcription-model>'
export PLATFORM_SPEECH_POLICY_REVISION='<reviewed-policy-revision>'
export PLATFORM_SPEECH_MICROUSD_PER_MINUTE='<verified-integer-price>'
export PLATFORM_SPEECH_FUNDING_SOURCES='addon'
export PLATFORM_SPEECH_SECRET='<a-separate-at-least-32-byte-local-secret>'
bun run dev:speech
```

The selected local runtime must already have an existing funded-AI runtime policy, balance, and eligible credit in the platform database. Speech does not require that text inference be enabled and does not consult the text model allowlist. Its reservation, dispatch start, exact/conservative settlement, and release use the existing machine-scoped wallet and ledger. `PLATFORM_SPEECH_FUNDING_SOURCES` may be `addon`, `promotional`, or `promotional,addon`; choose it deliberately so a text-only promotional campaign is not spent accidentally.

Do not put the OpenAI key in the runtime home, host bundle, gateway env file, renderer, or browser storage. Stop all three processes with Ctrl-C; the launcher sends termination to each child and the platform drains admitted speech work before closing its database.

Packaged Electron microphone checks and Native Mobile real-device validation are separate gates; this launcher validates the local platform/gateway/Web shell path.
