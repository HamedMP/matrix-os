# Data model

## Canonical owner credential

`OwnerOpenRouterCredential` is stored at
`system/ai-providers/openrouter-key.json` with schema version, key, generation,
created/updated timestamps, and optional revoked timestamp. The key is never
projected. Generation is an opaque UUID changed on every successful rotation or
revocation.

## Provider projection

- Account: `account_owner_openrouter`, provider `openrouter`, auth method
  `api_key`, owner-funded, readiness derived from the canonical file.
- Access source: `owner_openrouter`, reciprocal account binding.
- Instances: the four stable IDs in the spec, each binding driver, account,
  source, and a harness-specific exact model allowlist.
- Model availability: `available`, `unavailable`, or `legacy-selected` after a
  curated model disappears. Only `available` admits execution.

## Execution fingerprint

```text
instanceId + driverKind + providerId + accountId + accessSourceId
+ credentialGeneration + exactModelId
```

Every start/resume compares the persisted fingerprint against the current
server projection. A mismatch is a safe route error, never a fallback.

## State transitions

```text
absent -> staged -> connected(generation N)
connected(N) -> staged rotation -> connected(N+1)
connected(N) -> tombstoned(N+1) -> disconnected
```

Failed verification or transaction rollback leaves the previous committed
credential and projection unchanged. Tombstoned history remains sufficient to
invalidate old fingerprints but never exposes the key.

