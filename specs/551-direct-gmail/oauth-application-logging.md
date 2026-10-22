# Gmail application failure logging

ENG-355; part of the Gmail verification stack. Native Gmail lifecycle routes log only a fixed server operation and a coarse typed/untyped failure category. Provider/database/subscriber error objects, names, messages, causes, stacks and attached request data never cross that application logging boundary. Responses remain generic and connection/revocation behavior is preserved.

Tests first reproduced leakage through connect, OAuth completion, consent launch, refresh, revoke and subscriber failures, including synthetic tokens and request codes nested in error properties. The route regressions now verify both responses and actual logger arguments.

This does not sanitize Cloud Run, proxy or third-party access logs. Operators must configure and verify callback URL exclusions on every relevant logging sink before enabling direct OAuth or nonce-bearing Pipedream receipts. A deployment flag is an attestation, not evidence. No infrastructure exclusion or live callback is claimed by this source change. Public documentation remains the separate site PR287.
