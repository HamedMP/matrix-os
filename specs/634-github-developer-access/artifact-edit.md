# Guarded workspace edits for repository work

## 1. Scope / trigger

Managed Chat already exposes artifact read/write instead of an owner shell.
Create-only publication could add a file after cloning but could not edit an
existing source file. This bounded extension provides that missing operation.
It does not change GitHub approvals, grant access outside an admitted workspace,
or change the existing default publication behavior for native recipe Bots.

## 2. Signatures

- Model `read_artifact({path, withHash: true})` returns complete bounded text and
  its exact SHA-256; existing path-only and attachment-chunk reads remain valid.
- Model `write_artifact({path, content, mimeType, expectedSha256})` maps to
  `artifact.write.args.replace = {expectedSha256}`.
- The legacy `{replace: {baseRevision}}` contract remains refused; it is not a
  file-content revision store.

## 3. Contracts

The complete text/digest response has `kind: "artifact_text"`, `content`,
`sha256`, `size` in bytes, and `untrusted: true`. Existing 192 KiB text and
serialized broker-frame bounds remain authoritative. A missing expected hash
keeps managed writes create-only. A replacement requires an existing regular
file with one link, unchanged bytes, an admitted root/source and a safe path.
New content preserves the file mode. Git metadata and `.artifact-recovery`
segments are not model-addressable through artifact or GitHub actions.

The host stages and syncs complete new bytes for both Chat and Bot replacement,
rechecks cancellation after the final source-authority await, and captures the current inode into an owned
0700 recovery slot, verifies its identity/hash/mode, and publishes using an
exclusive link. A concurrent new target wins. This deliberately has a brief
absent-target window; it is not an atomic POSIX compare-and-swap replacement.
Recovery metadata and directories are synced before capture and publication
directory entries are synced before success is returned. Both locations must
be on the same filesystem.

## 4. Validation and error matrix

| Condition | Result |
| --- | --- |
| Stale expected digest | Refuse before capture; target unchanged |
| Symlink, hard link, reserved path, excessive bytes | Refuse |
| Unsafe/full recovery area or different filesystem | Refuse before capture |
| Source revocation or cancellation before capture | Refuse and remove the empty reservation |
| Changed inode/bytes/mode at capture | Retain captured data, restore exclusively when possible, report unknown |
| Concurrent target recreated after capture | Preserve that target and the captured inode; report unknown |
| Failure after capture/publication starts | Unknown effect; never automatically replay |

## 5. Good / base / bad cases

Good: read source and digest, write a guarded edit, read back, then request the
separate exact Git commit approval. Base: create a new file without replacement.
Bad: assume a stale digest authorizes an overwrite, overwrite a recreated owner
file, or treat a capture/publish failure as proof that nothing changed.

## 6. Required tests

Exercise actual model tool mapping through the shared broker schema to the
Chat and Bot dispatchers, tracked Git edits, stale hashes, symlinks, source changes,
mode changes, path recreation and late writes through an already-open Terminal
descriptor. Assert stage-sync failure and pre/post-capture cancellation preserve
owner bytes with the correct refusal/unknown classification. Check temporary cleanup and that the normal staging sweeper cannot
delete owner recovery bytes. Existing artifact publication, chunk-read recovery,
tool dispatcher and broker-contract suites must still pass.

## 7. Recovery ownership / wrong versus correct

The displaced inode is retained even after success because an already-open
Terminal descriptor may still write to it. Owner recovery lives under
`.artifact-recovery/slot-00` through `slot-63` in the owner home. These copies
are owner data, not expiring temporary files. The owner reviews `record.json`
and `previous` in their own Terminal and removes individual slots explicitly;
there is no automatic purge or cleanup UI. At 64 occupied slots, new guarded
edits stop safely. A crash before capture may leave a metadata-only reservation.

Wrong: check a hash then overwrite with rename, claiming external-writer CAS.
Correct: preserve the displaced inode, publish exclusively and retain uncertainty
for reconciliation when the operation cannot be confirmed.
