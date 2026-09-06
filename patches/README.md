# Dependency patches

## app-builder-lib 26.15.3: macOS signing keychain password

The macOS packager creates a temporary keychain with a generated password.
Version 26.15.3 instead supplies the certificate's import password to
`security set-key-partition-list`, which expects the temporary keychain
password. On macOS ARM64 this caused `SecKeychainUnlock` failures after a
successful app build and certificate import.

The patch threads the generated password through `importCerts`. Each
certificate keeps its own password for `security import -P`; only the
keychain access-control command uses the generated password. Signing,
notarization, identity discovery, and cleanup behavior are unchanged.

`tests/desktop/mac-signing-keychain.test.ts` exercises the installed module
resolved through Electron Desktop's actual dependency tree, intercepting
security commands so tests need no signing credentials or real keychains.
It covers application and installer certificates, an empty certificate
password, and propagation of access-control failures.

The root pnpm configuration and lockfile bind this patch to 26.15.3. On an
electron-builder upgrade, check the new `app-builder-lib` implementation;
remove the patch only once it uses the keychain password for partition-list
access, and keep the behavioral regression tests. CI's frozen install must
apply the patch before packaging.
