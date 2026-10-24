# Dependency patches

## app-builder-lib 26.15.3

`macCodeSign.createKeychain` creates a temporary keychain with a random password,
but the unpatched implementation passes the certificate's password to
`security set-key-partition-list`. On macOS ARM runners this fails with
`SecKeychainUnlock`, even after certificate import succeeds.

The patch carries the generated keychain password into ACL setup while keeping
each certificate password scoped to `security import`. Signing and notarization
remain enabled. `tests/desktop/macos-signing-keychain.test.ts` exercises the
installed dependency with OS calls intercepted, covering application-only and
application-plus-installer certificates without accessing real credentials.

When upgrading electron-builder, remove this patch only after verifying the new
dependency uses the correct password and the regression tests and signed macOS
builds pass on both architectures.

## image-size 1.2.1

Metro 0.84.4 still consumes the callable 1.x API; forcing 2.x would change that
contract. This patch rejects image boxes shorter than their headers or beyond
the buffer, including zero-sized matching `jxlp` boxes that the existing search
guard does not protect. ICNS entries must contain a full header, advance by at
least that header, and fit inside the declared container. Large-file buffered
prefixes remain supported without requiring their full image payloads in memory.

This addresses GHSA-5p2g-fcmc-qvqq and GHSA-w3rx-r6r6-pgpr while retaining the
installed version and API. It is a carried backport, not an upstream fixed
release. See `tests/deploy/dependency-security-backports.test.ts` for malformed
input deadline regressions and real Metro/API compatibility coverage.

## node-forge 1.4.0

The upstream proposal in digitalbazaar/forge PR 1152 adds an explicit child-count
check to the nested DigestAlgorithm sequence; `asn1.validate` alone permits
unconsumed children. This patch carries that check for GHSA-86w9-cpqp-85rv.
The advisory has no released fixed version as of October 24, 2026. The check is
carried in `lib/rsa.js` and both existing public UMD distributions. The two UMD
source-map links and their matching stale maps are removed; the separate prime
worker and its map are unchanged. No downloaded replacement bundle or additional
build tool is used.

The same regression suite exercises malicious nested elements with an e=3 test
key and valid optional-NULL signatures against all three installed entry forms,
plus the real Expo certificate, CSR and manifest signing functions. Optional
browser form/XHR transports remain unavailable in the UMD fixture. No real
signing material is accessed.

For both security patches, retain version-scanner findings alongside patch and
artifact evidence instead of suppressing them. Remove a patch only after an
owning dependency upgrade selects a supported fix and the security/API tests,
frozen install, normal builds and exact deployed artifact checks pass. Detailed
provenance and qualification gates are recorded in
`specs/551-direct-gmail/runtime-compatible-security-patches.md`.
