# Published Codex 0.169.0 qualification

[ENG-467](https://linear.app/matrix-os/issue/ENG-467) restores the provider-contract gate blocking [WhatsApp #2373](https://github.com/HamedMP/matrix-os/pull/2373). This extends the same fix's 0.167.2 qualification with exact 0.169.0 records. It preserves historical records, unknown-version rejection, the installed/runtime-selected 0.162.1 pin, and the separate Settings-native-auth allowlist.

## Published artifacts

- [Official release](https://github.com/openai/codex/releases/tag/rust-v0.169.0).
- [Tagged exec source](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/exec/src/exec_events.rs): SHA-256 `dafa872d7e86a099e56e28a329dcb9c03db90ed768c3b88cca8c91d46dc1d0e5`, identical to the retained 0.158 fixture.
- Exact `pnpm dlx @openai/codex@0.169.0 app-server generate-json-schema --experimental` on Darwin produced SHA-256 `d2d0612646b0739dd264067ef944442a5485e44529c793bebf3985e9a9df6cfc`. The gzip fixture retains those exact bytes.
- Both actual Linux x64 and Darwin arm64 jobs in [the failing contract run](https://github.com/HamedMP/matrix-os/actions/runs/43400530943) independently reported that same full schema and the three changed consumed digests. Those historical failures establish provenance; new-head target checks must still pass.

## Complete reviewed delta from 0.167.x

The regression normalizes only the 56 reviewed change paths in `tests/fixtures/codex-0169/reviewed-delta.json`, then compares the entire remaining tree with the retained 0.167 fixture. Exact-byte hashing independently protects the full new tree. This is a schema review, not a claim that Matrix enables the new upstream APIs.

- Four client requests were added: `account/securitySetup/read`, `modelProvider/config/write`, `modelProvider/list`, and `thread/prepareApprovedPlan`.
- Twenty-four definitions support account-security notices/actions; moderation/display metadata; Bedrock/GCP provider identities; gateway OAuth parameters/prompts/auth; provider configuration/listing/settings; deferred item output; approved plans; and web-search provider selection. Matrix does not invoke the new requests or interpret these display instructions as authority.
- `agentMessage` adds optional nullable `moderation`, with a required boolean and optional display instruction. Completed items add nullable nonnegative `contentTokenCount` telemetry. `CodexErrorInfo` adds `inferenceHookDenied`. These change only consumed `item/started`, `item/completed`, and `turn/completed` transitive digests. Approval, permissions, user-input and elicitation payload digests remain unchanged.
- Audio function output now accepts an audio URL or file ID; only `type` remains unconditionally required. Existing Matrix tool output handling remains unchanged; no new audio fetch is enabled.
- Optional fields were added for client search provider, gateway OAuth login identity/prompt/device capability, account user ID, MCP resource metadata, model provider selection, queued Responses metadata, parent-thread identity, deferred output, account/attached-thread filtering, in-progress sampling, and environment selection for future/current turns.
- Three descriptions changed: plugin starter prompts allow 512 characters instead of 128, guardian review mentions remembered approvals, and sampling documents the new in-progress option. These do not alter Matrix approval or sandbox policy.

## Verification and limits

After the routine bridge landed in main (#3062), this qualification preserves its required `item/tool/call` method, historical routine records, checker, runtime implementation and all negative controls. Exact 0.169.0 routine qualification adds one version record. `initialize`, `thread/start`, all three dynamic-tool definitions, and the server callback digest remain identical to 0.167.2. The `thread/resume` and `turn/start` transitive digests change only because they reference the already-reviewed audio URL/file-ID union; their request envelopes remain identical. The 0.169.0 fixture now exercises all seven routine-payload mutation guards after a whole-schema hash refresh. A new regression first failed on the missing version record, then passes with the reviewed record. No routine authorization is weakened.

- Regression red: exact 0.169.0 was rejected by both old contract records. Green: paired exact records admit it; unknown 0.168.0 and 0.169.1 still fail closed. Altered vendor bytes fail the hash guard. A changed approval payload still fails semantic verification even with a recomputed full-schema hash.
- A focused real-adapter subprocess fixture sends the new moderation/telemetry fields through the production app-server runner. Completed turns retain the answer; `inferenceHookDenied` remains a failed turn. Display metadata neither becomes an approval nor leaks into the transcript. This uses a bounded fake provider, no account credentials or paid inference.
- The exact official Darwin 0.169.0 executable also passes the retained isolated MCP/fake-Responses process probe: fresh turn returns sentinel A, loaded resume retains A despite replacement B, and cold-process resume returns C. Every turn reports `workspaceWrite` with `networkAccess: false`. Forced initialization cleanup and ten Python fixture controls pass. Temporary HOME/CODEX_HOME and the child environment exclude account credentials; this is a no-paid protocol fixture, not live account, Linux process-lifecycle, or network-isolation qualification.
- The retained 0.167.x qualification reconstructs its historical semantic pins; current verification remains strict. No live verifier guard was relaxed.
- Current-head full CI, both target schema generators, Greptile 5/5, and engineer review remain merge gates. No UI or installed tool behavior changes; public docs and new visual evidence are inapplicable to compatibility metadata only, subject to reviewer agreement.
