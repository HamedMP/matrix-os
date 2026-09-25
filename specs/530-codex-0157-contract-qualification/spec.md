# Codex 0.157.0 provider contract qualification

**Status:** Red test only; approval to promote the verified contract records is pending.

The scheduled Codex provider contract workflow resolved published `@openai/codex@0.157.0` and failed on both `linux-x64` and `darwin-arm64` at the intentional `latestVerifiedVersion` guard. The installed customer tool remains pinned to 0.156.1. This work qualifies the **exact** 0.157.0 exec JSONL source and experimental app-server protocol against Matrix's provider adapter; it does not promote the customer installer, permit arbitrary future versions, or change Claude MCP behavior.

## Acceptance contract

- Preserve every existing verified-version record. Add 0.157.0 to both exec and app-server contracts together, and set both latest-verified pointers to 0.157.0 only after its exact source and generated target schemas pass. Unknown versions continue to fail closed.
- Compare the complete generated JSON schema, including definitions reached by `$ref`. Unchanged method tags alone are insufficient. Revalidate all five required server methods and six required notifications through their transitive payload digests on both supported targets. Any changed required payload requires a focused parser/approval regression before promotion.
- Run the exact published 0.157.0 CLI in an isolated, no-paid stdio MCP process fixture with fake Responses and no real credentials. Cover fresh launch and cold resume under the existing sandbox. Record the known loaded-resume registration-replacement behavior; do not infer broader compatibility from the schema alone.
- Use the existing scheduled workflow's actual `linux-x64` and `darwin-arm64` schema generation and verifier on the proposed green head. A local macOS result and a previously observed CI digest do not replace current-head, both-target evidence.
- Keep `distro/customer-vps/host-bin/matrix-install-developer-tools` and `matrix-install-tool-pack` at 0.156.1. Installer promotion and affected customer runtime acceptance require a separate decision. No approval, auth, or sandbox policy changes are in scope.

## Red-to-green boundary

The checked-in [test](../../tests/scripts/check-codex-provider-contracts.test.ts) reads pinned upstream source and generated schema bytes. It fails at `Codex 0.157.0 is not verified` before the current checker reaches digest comparison. The green step is limited to exact, reviewed version records in the two contract JSON files, with required semantic digests retained only if both generated targets confirm them. Do not suppress or widen the guard. The [evidence manifest](evidence/manifest.md) records source provenance, structural diff, hashes, process evidence, and remaining validation.

Public documentation is a separate deliverable if a subsequent installer promotion changes supported user-facing Codex behavior: assess and, if needed, open a documentation PR in `FinnaAI/matrix-os-site/content/docs/`. This test-only qualification does not change the public product contract.
