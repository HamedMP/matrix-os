# Readiness and runtime troubleshooting

| Symptom | Check and next action |
| --- | --- |
| No collaborative declaration | Validate against the current manifest capability contract; add the building reference's exact V1 values. |
| Schema/ABI mismatch | Recompute the canonical table digest; compare registration with the declared schema. Use the supported bridge/runtime ABI, then rebuild. |
| Shared read/write/signal gate blocked | Inspect the loaded production scripts. Use actual collaboration queries, schema-valid mutations and onChange subscriptions on the normal UI path. Remove no safety checks to satisfy static inspection. |
| Build changed or needs recheck | Rebuild and recheck the current app. Never reuse an earlier certificate or manually change a share's build ID. |
| Readiness/share returns unauthenticated | Use the genuine verified owner session in Matrix. A scoped Chat integration token is not an owner session; guide the owner to Share app rather than copying credentials. |
| Host unavailable | Preserve mounted input; restore the owner runtime, use Matrix Retry, then reread. An empty local array is not recovery. |
| Write conflict or unknown outcome | Keep the draft. Use Matrix recovery and review saved records; never automatically resend as a fresh mutation or silently replace edits. |
| Access ended | Verify current organization membership and active share through normal controls. Do not fall back to the recipient's personal app or request owner credentials. |
| Provider-dependent feature fails | Sharing grants no owner integrations or AI spend. Explain which feature needs a separately supported policy. |
| Native Mobile requested | V1 shared custom apps run on web surfaces and Electron; guide Open on web and report native verification unavailable. |

A passed build/static preflight does not prove Matrix readiness. A readiness
certificate does not prove a live two-person journey. Keep the completion report
honest about which boundary was actually exercised.
