<!-- GENERATED FILE. DO NOT EDIT ANYTHING IN THIS DIRECTORY. -->

# Office engine (generated mirror)

Every file here except this one is a byte-for-byte copy of `packages/office/src/`
(the `@matrix-os/office` package). Default apps import it by relative path,
for example `../../_shared/office-engine/index.js`, because they are built
outside the workspace and cannot depend on the package.

- Change the engine in `packages/office/src/`, never here.
- Then run `node scripts/sync-office-engine.mjs` and commit the result.
- `tests/office/engine-mirror.test.ts` fails while this copy is stale
  (`node scripts/sync-office-engine.mjs --check`).
