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
