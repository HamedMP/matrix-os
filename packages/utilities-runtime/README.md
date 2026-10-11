# Utilities build runtime

Exact browser toolkit dependencies for the pinned website snapshot in `home/apps/utilities/toolkit-source.json`. This workspace has no service or persistent data. Build the app with `node scripts/build-utilities-app.mjs`; development preview uses `--dev`.

The host release includes this workspace and `scripts/build-utilities-app.mjs`. Source installs outside a checkout can set `MATRIX_RUNTIME_ROOT` to a complete source/release root; customer VPS installs use `/opt/matrix/app`. The app's source globs are local so a prebuilt template keeps its stamp after copying into the owner home.
