# Collect benchmark evidence from the live temporary filesystem

## Problem and correction

A real Docker 29.1.3 canary created `/work/results/unit-cold.json` inside the
running container, but `docker cp` could not find it in the temporary filesystem.
The missing evidence made successful benchmark execution unusable.

For each existing allowlisted filename, execute the trusted image's read-only
`/usr/bin/tar` as UID/GID 10001 in the live container and stream its single archive
member to the unchanged host validator. Keep the 30-second transfer deadline and
five-second kill grace. The image's read-only filesystem prevents test code from
replacing that executable. No shell, arbitrary archive arguments, extraction,
symlink dereferencing, host mounts, or credentials are added.

## Preserved bounds and validation

The existing validator accepts only the exact allowlisted regular member, rejects
extra members, links, directories, and oversized data, and retains its 50 MiB cap,
exclusive output creation, and rejection cleanup. Timeouts still immediately
kill the benchmark container and discard its temporary files before collection;
ordinary test failures still permit evidence collection. Successful execution
still fails closed when required evidence is missing or rejected.

The host canary verified that nonroot `docker exec` emits an archive accepted by
the unchanged validator. First capture a failing collector source contract, then
run runner isolation, benchmark, bridge, and controller checks, retaining the
existing archive security cases. Update the controller transfer-timeout matcher
to recognize the new transport. Public CI guide updates remain tracked in
[matrix-os-site #224](https://github.com/FinnaAI/matrix-os-site/pull/224).
