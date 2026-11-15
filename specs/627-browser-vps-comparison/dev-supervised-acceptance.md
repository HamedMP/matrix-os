# Scoped Supervised Browser validation on Dev

Use one owner Chat on an existing customer Computer with slot `dev`. The normal app route and the existing Platform verification endpoint carry the approval. This test uses the production owner session and a real Dev Gateway, so installing a Dev host bundle alone cannot enable the signer.

## Scope and authority

`MATRIX_SUPERVISED_BROWSER_DEV_SCOPE` is an operator-provided JSON object with `handle`, `machineId`, `ownerId`, `runtimeSlot` (`dev`), `chatId`, and UTC `expiresAt`. The configuration allows at most two hours at load time and is checked on every use. An absent scope leaves legacy configuration unchanged. An invalid, expired, or conflicting scope issues no scoped Browser authority. The actual scope and signing material stay in operator configuration.

| Existing path | Authority with a Dev scope |
| --- | --- |
| Owner Chat approval submission through the app | Verified owner session; normal exact runtime selection; current running authorized machine matches configured handle, slot, UUID and owner; exact Chat; `allow_once`, `not_now` or `cancel`. |
| Platform internal Browser proof verifier | Existing machine transport bearer and valid user proof; the live machine row and Chat match the same scope. |
| Dev Gateway Browser tool and decision handling | Root-managed configuration matches this Computer identity. Only the selected Chat gets the supervised tool and decisions. Existing persistent grants do not authorize this test. |

The scoped proof uses the existing action, request, lease and challenge tuple and proof format. Its signing key is bound to the scope and its expiry cannot exceed the scope cutoff, owner session expiry or existing proof lifetime. An expired or rotated scope fails closed. The normal lease, approval transaction and one-time consumption prevent replay. No default Platform feature enablement, Edge selector, migration or public route is needed.

## Validation and rollback

Test composed mint and verification with synthetic identities first. Include mismatched Chat, owner, machine UUID, slot, expiry, scope rotation, ordinary chats, and the unchanged default-disabled and legacy paths. On a reviewed, scoped shared Platform revision, run one normal owner Chat on Dev with the exact #2943 CDP change present. Observe actual Codex Browser tool discovery, owner approval, page navigation and reads across multiple steps, and run cleanup. Verify that a separate Chat cannot invoke this Browser authority. Record Dev build and Platform revision. A Browser-ready endpoint or local proof test does not qualify the Agent journey.

Activate the shared Platform revision only after operator approval. Leave the global feature flag off. Confirm the intended owner machine row and fresh expiry immediately before configuring both processes. Revert the scope on Platform and Dev after testing and verify that an expired or removed scope rejects new Browser actions. Keep the previous Dev release and configuration available for rollback. The existing public Browser guide remains the companion user documentation for ordinary setups.
